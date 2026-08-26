import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';

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

export function createEnvelopeSpoolPath(): string {
  return `${process.env.TMPDIR ?? '/tmp'}/papra-backup-envelope-${randomBytes(12).toString('hex')}.tmp`;
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
