import type { Config } from '../../../config/config.types';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { googleDriveBackupDriverFactory } from './google-drive.driver';
import {
  GOOGLE_DRIVE_OAUTH_TOKEN_ENDPOINT,
  GOOGLE_DRIVE_UPLOAD_ENDPOINT,
} from './google-drive.constants';

function createDriver() {
  return googleDriveBackupDriverFactory({
    config: {
      appBaseUrl: 'http://localhost:1221',
      backups: {
        googleDrive: {
          oauthClientId: 'client-id',
          oauthClientSecret: 'client-secret',
        },
      },
    } as Config,
  });
}

function jsonResponse(body: object, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('google drive driver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SESSION_URI = 'https://storage.googleapis.com/upload/session-1';

  function stubUploadFetch() {
    const putCalls: { url: string; init?: RequestInit; receivedBytes: number }[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.startsWith(GOOGLE_DRIVE_OAUTH_TOKEN_ENDPOINT)) {
        return jsonResponse({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' });
      }
      if (href.startsWith(GOOGLE_DRIVE_UPLOAD_ENDPOINT)) {
        return jsonResponse({}, { location: SESSION_URI });
      }
      // A real consumer drains the request body — which is what drives the
      // driver's pull()-based progress callbacks. Consume it fully here.
      let receivedBytes = 0;
      if (init?.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          receivedBytes += value.byteLength;
        }
      }
      putCalls.push({ url: href, init, receivedBytes });
      return jsonResponse({
        id: 'gfile_1',
        name: 'backup.papra-backup',
        mimeType: 'application/octet-stream',
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    return { putCalls };
  }

  test('reports byte-level progress while streaming the resumable upload', async () => {
    const { putCalls } = stubUploadFetch();
    const driver = createDriver();
    // Three chunks at the driver's 256 KiB chunk size.
    const content = Buffer.alloc(600 * 1024, 7);

    const uploads: number[] = [];
    const result = await driver.uploadFile({
      credentials: { refreshToken: 'rt' },
      settings: {},
      folderRef: 'folder_1',
      fileName: 'backup.papra-backup',
      mimeType: 'application/octet-stream',
      content,
      onProgress: ({ uploadedBytes }) => uploads.push(uploadedBytes),
    });

    expect(result.remoteFileId).toBe('gfile_1');
    expect(uploads).toEqual([256 * 1024, 512 * 1024, 600 * 1024]);

    // The body was streamed (duplex half), not sent as one Buffer, and every
    // byte made it through.
    const put = putCalls[0]!;
    expect(put.init?.body).toBeInstanceOf(ReadableStream);
    expect((put.init as RequestInit & { duplex?: string }).duplex).toBe('half');
    expect(put.receivedBytes).toBe(content.length);
  });

  test('sends the buffer directly when nobody listens for progress', async () => {
    const { putCalls } = stubUploadFetch();
    const driver = createDriver();

    await driver.uploadFile({
      credentials: { refreshToken: 'rt' },
      settings: {},
      folderRef: 'folder_1',
      fileName: 'backup.papra-backup',
      mimeType: 'application/octet-stream',
      content: Buffer.from('backup-bytes'),
    });

    expect(Buffer.from(putCalls[0]!.init!.body as Uint8Array).toString()).toBe('backup-bytes');
  });

  test('downloadFile streams the response body straight to disk instead of buffering it', async () => {
    const chunks = [Buffer.from('hello '), Buffer.from('streamed '), Buffer.from('world')];
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith(GOOGLE_DRIVE_OAUTH_TOKEN_ENDPOINT)) {
        return jsonResponse({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' });
      }
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < chunks.length) {
            controller.enqueue(chunks[index]!);
            index += 1;
          } else {
            controller.close();
          }
        },
      });
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(totalLength) : null) },
        body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const driver = createDriver();
    const destinationPath = join(tmpdir(), `gdrive-download-test-${randomBytes(6).toString('hex')}`);
    const progressUpdates: { downloadedBytes: number; totalBytes: number | null }[] = [];

    try {
      const result = await driver.downloadFile({
        credentials: { refreshToken: 'rt' },
        settings: {},
        remoteFileId: 'gfile_1',
        destinationPath,
        onProgress: (args) => progressUpdates.push(args),
      });

      expect(result.size).toBe(totalLength);
      expect((await readFile(destinationPath)).toString()).toBe('hello streamed world');
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates.at(-1)).toEqual({ downloadedBytes: totalLength, totalBytes: totalLength });
    } finally {
      await rm(destinationPath, { force: true });
    }
  });
});
