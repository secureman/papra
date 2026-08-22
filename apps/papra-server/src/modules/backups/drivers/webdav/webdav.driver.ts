import { Buffer } from 'node:buffer';
import { createLogger } from '../../../shared/logger/logger';
import { BACKUP_FILE_EXTENSION } from '../../backups.constants';
import { createBackupDriverApiError } from '../../backups.errors';
import { defineBackupDriver } from '../drivers.models';
import type { WebdavPreset } from './webdav.presets';
import { resolveWebdavRootUrl } from './webdav.presets';

const logger = createLogger({ namespace: 'backups:drivers:webdav' });

export const WEBDAV_DRIVER_NAME = 'webdav';

type WebdavSettings = {
  baseUrl: string;
  preset?: WebdavPreset;
  remotePath?: string; // sub-folder under the WebDAV root, e.g. "Papra Backups"
};

function getRootUrl({
  settings,
  credentials,
}: {
  settings: WebdavSettings;
  credentials: { username?: string };
}): string {
  return resolveWebdavRootUrl({
    preset: settings.preset ?? 'generic',
    baseUrl: settings.baseUrl,
    username: credentials.username,
  });
}

function getAuthHeader({ username, password }: { username: string; password: string }): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// Path segments (folder names, file names) can contain spaces or other
// characters that aren't valid raw in a URL — the default folder name is
// literally "Papra Backups", a space right there. Every WebDAV call used to
// build the URL by string-concatenating the raw path onto the root, which
// worked by accident on some servers (loose URL parsers) and broke outright
// on others (a strict `fetch()`/`URL` implementation either throws on the
// space or leaves it un-encoded on the wire, and most WebDAV servers reject
// or 404 on that). Encode each segment individually so `/` stays a
// separator but everything inside a segment gets escaped.
function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function joinUrl(root: string, path: string): string {
  return `${root.replace(/\/+$/, '')}/${encodePathSegments(path.replace(/^\/+/, ''))}`;
}

// Minimal PROPFIND response parser. We only need the href + displayname of each
// entry, so a small regex pass is enough and avoids pulling in an XML parser dep.
function parsePropfindHrefs(xml: string): string[] {
  const matches = [...xml.matchAll(/<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/gi)];
  return matches.map((m) => decodeURIComponent(m[1]!.trim()));
}

export const webdavBackupDriverFactory = defineBackupDriver(() => {
  async function request({
    settings,
    credentials,
    path,
    method,
    body,
    headers,
    streamDuplex,
  }: {
    settings: WebdavSettings;
    credentials: { username?: string; password?: string };
    path: string;
    method: string;
    body?: Buffer | string | ReadableStream<Uint8Array>;
    headers?: Record<string, string>;
    // Set when `body` is a ReadableStream — Node's fetch (undici) requires
    // `duplex: 'half'` to be explicitly set for streamed request bodies.
    streamDuplex?: boolean;
  }): Promise<Response> {
    const { username, password } = credentials;
    if (!username || !password) {
      throw createBackupDriverApiError();
    }
    const root = getRootUrl({ settings, credentials });
    const url = joinUrl(root, path);

    const response = await fetch(url, {
      method,
      headers: { Authorization: getAuthHeader({ username, password }), ...(headers ?? {}) },
      body: body as RequestInit['body'],
      ...(streamDuplex ? { duplex: 'half' as const } : {}),
    });

    if (!response.ok && response.status !== 207 /* Multi-Status, used by PROPFIND */) {
      const text = await response.text().catch(() => '');
      logger.error({ url, method, status: response.status, text }, 'WebDAV request failed');
      throw createBackupDriverApiError();
    }
    return response;
  }

  return {
    name: WEBDAV_DRIVER_NAME,
    requiredCredentialFields: ['username', 'password'],

    async testConnection({ credentials, settings }) {
      const s = settings as unknown as WebdavSettings;
      await request({
        settings: s,
        credentials,
        path: '',
        method: 'PROPFIND',
        headers: { Depth: '0' },
      });
      return { accountLabel: `${credentials.username}@${new URL(s.baseUrl).host}` };
    },

    async ensureRemoteFolder({ credentials, settings }) {
      const s = settings as unknown as WebdavSettings;
      const folderPath = s.remotePath ?? 'Papra Backups';
      const root = getRootUrl({ settings: s, credentials });
      const authHeader = getAuthHeader({
        username: credentials.username!,
        password: credentials.password!,
      });

      // MKCOL only creates one collection level — a nested remotePath like
      // "Documents/Papra Backups" needs "Documents" to already exist, or the
      // server replies 409 Conflict (not the "already exists" 405 we used to
      // treat as success). Walk the path segment by segment, creating each
      // ancestor before the next: by the time we reach the last segment its
      // parent is guaranteed to exist, so a 409/405 there really does just
      // mean "this one's already there".
      const segments = folderPath.split('/').filter(Boolean);
      let builtPath = '';
      for (const segment of segments) {
        builtPath = builtPath ? `${builtPath}/${segment}` : segment;
        const url = joinUrl(root, builtPath);
        const response = await fetch(url, {
          method: 'MKCOL',
          headers: { Authorization: authHeader },
        });
        if (!response.ok && response.status !== 405 && response.status !== 409) {
          const text = await response.text().catch(() => '');
          logger.error({ url, status: response.status, text }, 'WebDAV MKCOL failed');
          throw createBackupDriverApiError();
        }
      }
      return { folderRef: folderPath };
    },

    async uploadFile({ credentials, settings, folderRef, fileName, content, onProgress }) {
      const s = settings as unknown as WebdavSettings;
      const path = `${folderRef}/${fileName}`;
      // Stream the body in chunks (rather than one opaque Buffer) purely so
      // we can call onProgress as each chunk is pulled — the server still
      // receives the exact same bytes either way. Falls back to passing the
      // Buffer directly when nobody's listening for progress, since Node's
      // fetch requires `duplex: 'half'` for a streamed body and there's no
      // reason to pay that complexity when it's not needed.
      if (!onProgress) {
        await request({ settings: s, credentials, path, method: 'PUT', body: content });
        return { remoteFileId: path, remoteFileName: fileName };
      }
      const CHUNK_SIZE = 256 * 1024;
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= content.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + CHUNK_SIZE, content.length);
          controller.enqueue(content.subarray(offset, end));
          offset = end;
          onProgress({ uploadedBytes: offset });
        },
      });
      await request({
        settings: s,
        credentials,
        path,
        method: 'PUT',
        body: body as unknown as Buffer,
        streamDuplex: true,
      });
      return { remoteFileId: path, remoteFileName: fileName };
    },

    async downloadFile({ credentials, settings, remoteFileId }) {
      const s = settings as unknown as WebdavSettings;
      const response = await request({
        settings: s,
        credentials,
        path: remoteFileId,
        method: 'GET',
      });
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },

    async deleteFile({ credentials, settings, remoteFileId }) {
      const s = settings as unknown as WebdavSettings;
      await request({ settings: s, credentials, path: remoteFileId, method: 'DELETE' });
    },

    async listFiles({ credentials, settings, folderRef }) {
      const s = settings as unknown as WebdavSettings;
      const response = await request({
        settings: s,
        credentials,
        path: folderRef,
        method: 'PROPFIND',
        headers: { Depth: '1' },
      });
      const xml = await response.text();
      const hrefs = parsePropfindHrefs(xml);
      const root = getRootUrl({ settings: s, credentials });
      const rootPath = new URL(root).pathname.replace(/\/+$/, '');

      return {
        files: hrefs
          .map((href) => new URL(href, root).pathname)
          .filter((p) => p.replace(/\/+$/, '') !== `${rootPath}/${folderRef}`.replace(/\/+$/, ''))
          .filter((p) => !p.endsWith('/')) // directories/collections
          .filter((p) => p.endsWith(BACKUP_FILE_EXTENSION)) // ignore anything else parked in the folder
          .map((p) => ({
            remoteFileId: p.slice(rootPath.length).replace(/^\/+/, ''),
            name: decodeURIComponent(p.split('/').pop() ?? p),
          })),
      };
    },
  };
});
