import { Readable, Writable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Client } from 'basic-ftp';
import { createLogger } from '../../../shared/logger/logger';
import { createBackupDriverApiError } from '../../backups.errors';
import { defineBackupDriver } from '../drivers.models';

const logger = createLogger({ namespace: 'backups:drivers:ftp' });

export const FTP_DRIVER_NAME = 'ftp';

type FtpSettings = {
  host: string;
  port?: number;
  // FTPS (explicit TLS). Defaults to *off*: this is a self-hosted backup
  // target, and the overwhelming majority of self-hosted/home FTP servers
  // (a Synology/QNAP NAS, a Pi, a router's USB share) run plain FTP with no
  // TLS cert configured at all. The previous default of `true` meant every
  // one of those connections attempted an FTPS handshake the server didn't
  // support and failed outright — "FTP isn't working" was this, not a real
  // connectivity problem. Anyone who *does* have FTPS set up can still turn
  // it on explicitly.
  secure?: boolean;
  remotePath?: string;
};

// Defensive: strip a pasted "ftp://" prefix and split out a trailing ":port" so a
// messy Host field still connects instead of failing DNS resolution.
function parseHostAndPort({ host, port }: { host: string; port?: number }): {
  host: string;
  port: number;
} {
  let value = host
    .trim()
    .replace(/^ftps?:\/\//i, '')
    .replace(/\/+$/, '');
  let parsedPort = port;

  const portMatch = value.match(/^(.*):(\d+)$/);
  if (portMatch) {
    value = portMatch[1]!;
    parsedPort = Number(portMatch[2]);
  }

  return { host: value, port: parsedPort ?? 21 };
}

async function withClient<T>({
  credentials,
  settings,
  fn,
}: {
  credentials: { username?: string; password?: string };
  settings: FtpSettings;
  fn: (client: Client) => Promise<T>;
}): Promise<T> {
  const { username, password } = credentials;
  if (!username || !password) {
    throw createBackupDriverApiError();
  }

  const { host, port } = parseHostAndPort(settings);

  const client = new Client(30_000);
  try {
    await client.access({
      host,
      port,
      user: username,
      password,
      secure: settings.secure ?? false,
    });
    return await fn(client);
  } catch (error) {
    logger.error({ error, host: settings.host }, 'FTP operation failed');
    throw createBackupDriverApiError();
  } finally {
    client.close();
  }
}

export const ftpBackupDriverFactory = defineBackupDriver(() => {
  return {
    name: FTP_DRIVER_NAME,
    requiredCredentialFields: ['username', 'password'],

    async testConnection({ credentials, settings }) {
      const s = settings as unknown as FtpSettings;
      await withClient({ credentials, settings: s, fn: async (client) => client.pwd() });
      return { accountLabel: `${credentials.username}@${s.host}` };
    },

    async ensureRemoteFolder({ credentials, settings }) {
      const s = settings as unknown as FtpSettings;
      const folderPath = s.remotePath ?? 'papra-backups';
      await withClient({
        credentials,
        settings: s,
        fn: async (client) => {
          await client.ensureDir(folderPath);
        },
      });
      return { folderRef: folderPath };
    },

    async uploadFile({ credentials, settings, folderRef, fileName, content, onProgress }) {
      const s = settings as unknown as FtpSettings;
      await withClient({
        credentials,
        settings: s,
        fn: async (client) => {
          await client.ensureDir(folderRef);
          if (onProgress) {
            // basic-ftp reports *total bytes transferred on the current
            // operation*, not a delta — that's exactly the shape onProgress
            // wants, so pass it straight through.
            client.trackProgress((info) => onProgress({ uploadedBytes: info.bytes }));
          }
          try {
            await client.uploadFrom(Readable.from(content), fileName);
          } finally {
            client.trackProgress(); // stop tracking so the handler isn't kept alive/reused across calls
          }
        },
      });
      return { remoteFileId: `${folderRef}/${fileName}`, remoteFileName: fileName };
    },

    async downloadFile({ credentials, settings, remoteFileId, destinationPath, onProgress }) {
      const s = settings as unknown as FtpSettings;
      await withClient({
        credentials,
        settings: s,
        fn: async (client) => {
          if (onProgress) {
            client.trackProgress((info) =>
              onProgress({ downloadedBytes: info.bytesOverall, totalBytes: null }),
            );
          }
          try {
            // basic-ftp streams straight into whatever Writable it's given —
            // pointing it at a file on disk instead of an in-memory chunk
            // array means the download never holds the file's bytes in RAM
            // at all, regardless of how large it is.
            await client.downloadTo(createWriteStream(destinationPath), remoteFileId);
          } finally {
            client.trackProgress(); // stop tracking so the handler isn't kept alive/reused across calls
          }
        },
      });
      const { size } = await stat(destinationPath);
      return { size };
    },

    async deleteFile({ credentials, settings, remoteFileId }) {
      const s = settings as unknown as FtpSettings;
      await withClient({
        credentials,
        settings: s,
        fn: async (client) => client.remove(remoteFileId),
      });
    },

    async listFiles({ credentials, settings, folderRef }) {
      const s = settings as unknown as FtpSettings;
      const entries = await withClient({
        credentials,
        settings: s,
        fn: async (client) => {
          await client.cd(folderRef);
          return client.list();
        },
      });
      return {
        files: entries
          .filter((e) => e.isFile)
          .map((e) => ({
            remoteFileId: `${folderRef}/${e.name}`,
            name: e.name,
            size: e.size,
            modifiedAt: e.modifiedAt,
          })),
      };
    },
  };
});
