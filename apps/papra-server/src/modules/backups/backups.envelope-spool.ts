import { randomBytes } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Backups used to be built entirely in RAM (every document buffered, then the
// tarball, the gzip output and the encrypted payload each copied on top) — a
// 300 MB library peaked at ~700 MB+ of RSS and OOM-killed small servers the
// moment someone hit "Run backup now". The envelope is now streamed to one
// spool file in the OS temp dir instead: peak memory is roughly ONE document,
// whatever the library size.
//
// Ownership rules:
//   - The pipeline deletes the spool file when the upload finishes/fails.
//   - Local-destination runs hand ownership to backups.local-delivery.service,
//     which deletes it on expiry/discard/after the client's one-shot download.
//   - Download routes stream the file to the client and delete it on every
//     terminal stream event ('end'/'error'/'close', see backups.routes.ts).
//
// None of that survives a dead process though: every cleanup path lives inside
// the process that built the file, so a crash/restart mid-run strands it in the
// temp dir until cleanupOrphanedEnvelopeSpoolFiles() sweeps it at boot or on a
// periodic scheduler tick.

const ENVELOPE_SPOOL_FILE_NAME_REGEX = /^papra-backup-envelope-[0-9a-f]+\.tmp$/;

export function getEnvelopeSpoolDir(): string {
  return process.env.TMPDIR ?? '/tmp';
}

export function createEnvelopeSpoolPath(): string {
  return `${getEnvelopeSpoolDir()}/papra-backup-envelope-${randomBytes(12).toString('hex')}.tmp`;
}

// Best-effort delete — never throws (the file may already be gone if the
// server restarted mid-run or the claim raced the expiry timer).
export async function deleteEnvelopeSpoolFile({ path }: { path: string }): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already deleted / never created — nothing to do.
  }
}

// Deletes envelope spool files orphaned by previous processes. Every cleanup
// path above dies with the process that owns the file, so a crashed/killed/
// restarted server leaves fully or partially written envelopes behind forever
// — enough of them and the disk fills up and every new backup run fails mid-
// packaging with "ENOSPC: no space left on device".
//
//   - Called at boot (see start.ts): all pipelines are fire-and-forget
//     in-process, so no live owner exists yet and maxAgeMs stays 0 — every
//     matching file is garbage.
//   - Called periodically (backup scheduler tick): pass maxAgeMs > 0 so files
//     actively written/read by a live run are left alone.
//
// Best-effort by design: never throws; returns how many files were removed.
export async function cleanupOrphanedEnvelopeSpoolFiles({
  dir = getEnvelopeSpoolDir(),
  maxAgeMs = 0,
}: {
  dir?: string;
  // Files modified more recently than this are skipped — a live run may still
  // be writing/reading them. 0 disables the age check entirely (boot sweep).
  maxAgeMs?: number;
} = {}): Promise<number> {
  let fileNames: string[];
  try {
    fileNames = await readdir(dir);
  } catch {
    // Missing/unreadable temp dir — nothing to clean.
    return 0;
  }

  let deletedCount = 0;

  for (const fileName of fileNames) {
    if (!ENVELOPE_SPOOL_FILE_NAME_REGEX.test(fileName)) {
      continue;
    }

    const filePath = join(dir, fileName);

    try {
      if (maxAgeMs > 0) {
        const { mtimeMs } = await stat(filePath);
        if (Date.now() - mtimeMs < maxAgeMs) {
          continue;
        }
      }
      await unlink(filePath);
      deletedCount++;
    } catch {
      // Already gone / momentarily locked — best-effort, keep going.
    }
  }

  return deletedCount;
}
