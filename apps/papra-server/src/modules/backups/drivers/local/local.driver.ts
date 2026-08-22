import type { BackupDriver } from '../drivers.models';

// "Local" used to mean a folder on the *server's* container filesystem, which
// is nearly useless for a self-hosted setup: the person browsing the backups
// page usually isn't the same machine as the server, so a "local" backup was
// silently landing somewhere they'd never see it (inside the docker
// container, gone on the next rebuild unless volume-mounted just right).
//
// This driver is now a thin marker only. The actual delivery — building the
// envelope and getting bytes to a folder the *browser's* machine can reach —
// happens in runBackupPipeline (server) + the backups page (client, via the
// File System Access API / a plain download as a fallback). None of the
// methods below are called in that flow; they exist so the driver registry
// and any code that iterates all drivers generically doesn't have to
// special-case 'local' out of existence, and so they fail loudly (rather than
// silently writing to a path nobody will ever open) if something ever does
// call them by mistake.
export const LOCAL_DRIVER_NAME = 'local' as const;

function unsupported(method: string): never {
  throw new Error(
    `Local backup destinations don't support ${method} — the file lives on your device, not on the server. `
    + `Use the download prompt on the backups page instead.`,
  );
}

export const localBackupDriverFactory = (): BackupDriver => ({
  name: LOCAL_DRIVER_NAME,
  requiredCredentialFields: [], // No credentials needed for local

  // Nothing to verify — there's no server-side path or connection anymore.
  testConnection: async () => ({ accountLabel: 'Saved to your device' }),

  // No server-side folder either; folderRef is unused by the local flow.
  ensureRemoteFolder: async () => ({ folderRef: '' }),

  uploadFile: async () => unsupported('uploadFile'),
  downloadFile: async () => unsupported('downloadFile'),
  deleteFile: async () => unsupported('deleteFile'),

  // Returns empty rather than throwing: "browse remote backups" and similar
  // listing UIs call this generically across all destinations, and an empty
  // list degrades gracefully (nothing to show) instead of breaking that page
  // for every *other* destination too.
  listFiles: async () => ({ files: [] }),
});
