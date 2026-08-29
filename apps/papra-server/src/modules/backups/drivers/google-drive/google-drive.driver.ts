import type { Config } from '../../../config/config.types';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createLogger } from '../../../shared/logger/logger';
import { createBackupDriverApiError } from '../../backups.errors';
import { defineBackupDriver } from '../drivers.models';
import {
  GOOGLE_DRIVE_BACKUP_FILE_MIME_TYPE,
  GOOGLE_DRIVE_DEFAULT_FOLDER_NAME,
  GOOGLE_DRIVE_FILES_ENDPOINT,
  GOOGLE_DRIVE_REQUEST_TIMEOUT_MS,
  GOOGLE_DRIVE_UPLOAD_ENDPOINT,
} from './google-drive.constants';
import { createGoogleDriveOAuthService } from './google-drive.oauth.service';

const logger = createLogger({ namespace: 'backups:drivers:google-drive' });

export const GOOGLE_DRIVE_DRIVER_NAME = 'google_drive';

type DriveFile = { id: string; name: string; mimeType: string; size?: string };

export const googleDriveBackupDriverFactory = defineBackupDriver(({ config }) => {
  const oauth = createGoogleDriveOAuthService({ config });

  // Access tokens are short-lived (~1h) and not worth persisting; we just refresh
  // from the stored refresh token on every operation. Simpler and avoids a second
  // encrypted-at-rest secret to manage.
  async function getAccessToken({ refreshToken }: { refreshToken: string }): Promise<string> {
    const { access_token } = await oauth.refreshAccessToken({ refreshToken });
    return access_token;
  }

  async function authorizedFetch({
    refreshToken,
    url,
    init,
    accessToken: preFetchedAccessToken,
  }: {
    refreshToken: string;
    url: string;
    init: RequestInit;
    // Lets a caller that already fetched a token moments ago (e.g. the
    // upload session-init call, immediately followed by the PUT) reuse it
    // instead of paying for another round trip to Google's OAuth endpoint.
    accessToken?: string;
  }): Promise<Response> {
    const accessToken = preFetchedAccessToken ?? (await getAccessToken({ refreshToken }));

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), GOOGLE_DRIVE_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      response = await fetch(url, {
        ...init,
        headers,
        signal: timeoutController.signal,
      });
    } catch (error) {
      if (timeoutController.signal.aborted) {
        logger.error({ url }, 'Google Drive API call timed out');
        throw createBackupDriverApiError();
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text();
      logger.error({ url, status: response.status, body }, 'Google Drive API call failed');
      throw createBackupDriverApiError();
    }
    return response;
  }

  return {
    name: GOOGLE_DRIVE_DRIVER_NAME,
    requiredCredentialFields: ['refreshToken'],

    async testConnection({ credentials }) {
      const refreshToken = credentials.refreshToken;
      if (!refreshToken) {
        throw createBackupDriverApiError();
      }
      const accessToken = await getAccessToken({ refreshToken });
      const email = await oauth.fetchUserEmail({ accessToken });
      return { accountLabel: email ?? undefined };
    },

    async ensureRemoteFolder({ credentials, settings }) {
      const refreshToken = credentials.refreshToken!;
      const folderName =
        (settings.folderName as string | undefined) ?? GOOGLE_DRIVE_DEFAULT_FOLDER_NAME;

      const q = encodeURIComponent(
        `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`,
      );
      const findUrl = `${GOOGLE_DRIVE_FILES_ENDPOINT}?q=${q}&fields=files(id,name)`;
      const findResponse = await authorizedFetch({
        refreshToken,
        url: findUrl,
        init: { method: 'GET' },
      });
      const { files } = (await findResponse.json()) as { files: DriveFile[] };
      if (files[0]) {
        return { folderRef: files[0].id };
      }

      const createResponse = await authorizedFetch({
        refreshToken,
        url: GOOGLE_DRIVE_FILES_ENDPOINT,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
          }),
        },
      });
      const created = (await createResponse.json()) as DriveFile;
      return { folderRef: created.id };
    },

    // Resumable upload: start a session, then PUT the bytes. Handles backups
    // larger than the 5MB multipart-upload ceiling. The body may be an
    // in-memory Buffer or a stream (spooled envelope read from disk) — either
    // way it's sent progressively so peak memory stays flat.
    async uploadFile({ credentials, folderRef, fileName, mimeType, content, contentLength, onProgress }) {
      const refreshToken = credentials.refreshToken!;
      const accessToken = await getAccessToken({ refreshToken });

      const sessionInitResponse = await authorizedFetch({
        refreshToken,
        accessToken,
        url: `${GOOGLE_DRIVE_UPLOAD_ENDPOINT}?uploadType=resumable`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ name: fileName, mimeType, parents: [folderRef] }),
        },
      });
      const sessionUri = sessionInitResponse.headers.get('Location');
      if (!sessionUri) {
        throw createBackupDriverApiError();
      }

      const totalBytes = contentLength ?? (content instanceof Buffer ? content.length : undefined);
      if (totalBytes === undefined) {
        throw new Error('Streamed uploads require an explicit contentLength.');
      }

      // Stream the body rather than relying on chunked transfer-encoding:
      // Content-Length is set explicitly — we always know the full size
      // upfront (Buffer length or spool file stat), and a declared length lets
      // Google's resumable-upload backend do one contiguous transfer instead
      // of negotiating small internal writes whose per-write round-trip cost
      // is the difference between "slow" and "as fast as the connection
      // allows" on high-latency links.
      //
      // Progress is reported as undici pulls each slice: for a Buffer we wrap
      // it in a pull-based ReadableStream with 256 KiB slices; for a stream
      // body we count bytes through a passthrough TransformStream.
      let uploadBody: ReadableStream<Uint8Array> | Buffer;
      let uploadedBytes = 0;
      const duplex = {} as { duplex?: 'half' };
      if (content instanceof Buffer) {
        uploadBody = content;
        if (onProgress) {
          const CHUNK_SIZE = 256 * 1024;
          let offset = 0;
          uploadBody = new ReadableStream<Uint8Array>({
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
          duplex.duplex = 'half';
        }
      } else {
        // `content` is the raw spooled-envelope stream. TS doesn't narrow a
        // `Buffer | ReadableStream` union through `instanceof` here, so alias
        // it to its web-stream type explicitly.
        const source = content as ReadableStream<Uint8Array>;
        uploadBody = onProgress
          ? source.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>(
                {
                  transform(chunk, controller) {
                    controller.enqueue(chunk);
                    uploadedBytes += chunk.byteLength;
                    onProgress({ uploadedBytes });
                  },
                },
                { highWaterMark: 4 * 1024 * 1024 },
              ),
            )
          : source;
        duplex.duplex = 'half';
      }

      const uploadResponse = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Type': mimeType || GOOGLE_DRIVE_BACKUP_FILE_MIME_TYPE,
          'Content-Length': String(totalBytes),
          'Authorization': `Bearer ${accessToken}`,
        },
        body: uploadBody,
        ...duplex,
      } as RequestInit);
      if (!uploadResponse.ok) {
        const body = await uploadResponse.text();
        logger.error({ status: uploadResponse.status, body }, 'Google Drive upload failed');
        throw createBackupDriverApiError();
      }
      const uploaded = (await uploadResponse.json()) as DriveFile;
      return { remoteFileId: uploaded.id, remoteFileName: uploaded.name };
    },

    async downloadFile({ credentials, remoteFileId, destinationPath, onProgress }) {
      const refreshToken = credentials.refreshToken!;
      const url = `${GOOGLE_DRIVE_FILES_ENDPOINT}/${remoteFileId}?alt=media`;
      const response = await authorizedFetch({ refreshToken, url, init: { method: 'GET' } });

      const totalBytes = (() => {
        const header = response.headers.get('content-length');
        const parsed = header ? Number(header) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
      })();

      const writeStream = createWriteStream(destinationPath);

      if (!response.body) {
        // Some fetch implementations/environments don't expose a streamable
        // body — fall back to buffering the whole thing at once. No progress
        // in this case, but the download itself still works. Rare in
        // practice (undici, Node's default fetch, always exposes a body).
        const arrayBuffer = await response.arrayBuffer();
        await new Promise<void>((resolvePromise, reject) => {
          writeStream.on('error', reject);
          writeStream.end(Buffer.from(arrayBuffer), () => resolvePromise());
        });
        const { size } = await stat(destinationPath);
        return { size };
      }

      const reader = response.body.getReader();
      let downloadedBytes = 0;

      // Per-chunk inactivity timeout rather than a total-duration one — a
      // large backup file legitimately takes a while, but the connection
      // genuinely stalling (no bytes at all for a full minute) shouldn't be
      // able to hang the restore forever with no feedback.
      const readNextChunk = () =>
        Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Download stalled: no data received')), 60_000);
          }),
        ]);

      try {
        for (;;) {
          const { done, value } = await readNextChunk();
          if (done) {
            break;
          }
          // Written straight to disk as it arrives instead of collected into
          // an in-memory chunks array — a 700MB backup previously meant a
          // 700MB chunks array PLUS a second 700MB Buffer.concat() copy held
          // simultaneously, which is what OOM-killed constrained hosts
          // (Termux/udocker) on large-org restores.
          const canContinue = writeStream.write(Buffer.from(value));
          if (!canContinue) {
            await new Promise<void>((resolvePromise) => writeStream.once('drain', resolvePromise));
          }
          downloadedBytes += value.byteLength;
          onProgress?.({ downloadedBytes, totalBytes });
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        writeStream.destroy();
        logger.error(
          { url, downloadedBytes, totalBytes },
          'Google Drive download stalled or failed',
        );
        throw error;
      }

      await new Promise<void>((resolvePromise, reject) => {
        writeStream.on('error', reject);
        writeStream.end(() => resolvePromise());
      });

      const { size } = await stat(destinationPath);
      return { size };
    },

    async deleteFile({ credentials, remoteFileId }) {
      const refreshToken = credentials.refreshToken!;
      await authorizedFetch({
        refreshToken,
        url: `${GOOGLE_DRIVE_FILES_ENDPOINT}/${remoteFileId}`,
        init: { method: 'DELETE' },
      });
    },

    async listFiles({ credentials, folderRef }) {
      const refreshToken = credentials.refreshToken!;
      const q = encodeURIComponent(`'${folderRef}' in parents and trashed=false`);
      const fields = 'files(id,name,size,modifiedTime)';
      const url = `${GOOGLE_DRIVE_FILES_ENDPOINT}?q=${q}&fields=${fields}&pageSize=50&orderBy=createdTime desc`;
      const response = await authorizedFetch({ refreshToken, url, init: { method: 'GET' } });
      const { files } = (await response.json()) as {
        files: (DriveFile & { modifiedTime?: string })[];
      };
      return {
        files: files.map((f) => ({
          remoteFileId: f.id,
          name: f.name,
          size: f.size ? Number(f.size) : undefined,
          modifiedAt: f.modifiedTime ? new Date(f.modifiedTime) : undefined,
        })),
      };
    },
  };
});

export type { Config };
