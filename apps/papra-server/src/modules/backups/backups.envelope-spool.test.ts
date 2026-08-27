import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  cleanupOrphanedEnvelopeSpoolFiles,
  createEnvelopeSpoolPath,
} from './backups.envelope-spool';

// Uses the real filesystem on purpose: the sweep's behavior depends on actual
// readdir/stat/unlink semantics (mtime aging, ENOENT tolerance), which an
// in-memory mock would just restate.
describe('envelope spool', () => {
  let dir: string;

  const spoolFile = (suffix: string) => join(dir, `papra-backup-envelope-${suffix}.tmp`);
  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'papra-envelope-spool-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('cleanupOrphanedEnvelopeSpoolFiles', () => {
    test('deletes every envelope spool file when no age filter is passed (boot sweep)', async () => {
      const envelopes = ['aaaa1111bbbb2222cccc3333', 'dddd4444eeee5555ffff6666'];
      for (const suffix of envelopes) {
        await writeFile(spoolFile(suffix), 'x');
      }
      // Neighbors that must survive: not envelope spool names.
      await writeFile(join(dir, 'unrelated.tmp'), 'x');
      await writeFile(join(dir, 'other-file.txt'), 'x');

      const deletedCount = await cleanupOrphanedEnvelopeSpoolFiles({ dir });

      expect(deletedCount).toBe(2);
      for (const suffix of envelopes) {
        await expect(exists(spoolFile(suffix))).resolves.toBe(false);
      }
      await expect(exists(join(dir, 'unrelated.tmp'))).resolves.toBe(true);
      await expect(exists(join(dir, 'other-file.txt'))).resolves.toBe(true);
    });

    test('only touches files not matching the spool naming pattern', async () => {
      // Same prefix family, but not produced by createEnvelopeSpoolPath.
      await writeFile(join(dir, 'papra-backup-envelope-somethingelse.tmp'), 'x');
      await writeFile(join(dir, 'papra-backup-envelope-.tmp'), 'x');

      const deletedCount = await cleanupOrphanedEnvelopeSpoolFiles({ dir });

      expect(deletedCount).toBe(0);
      await expect(exists(join(dir, 'papra-backup-envelope-somethingelse.tmp'))).resolves.toBe(
        true,
      );
      await expect(exists(join(dir, 'papra-backup-envelope-.tmp'))).resolves.toBe(true);
    });

    test('with maxAgeMs, skips recent files (live runs) and deletes aged ones', async () => {
      const staleSuffix = 'aaaa1111bbbb2222cccc3333';
      const freshSuffix = 'dddd4444eeee5555ffff6666';
      await writeFile(spoolFile(staleSuffix), 'x');
      await writeFile(spoolFile(freshSuffix), 'x');
      // Make one of them look two hours old.
      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(spoolFile(staleSuffix), oldDate, oldDate);

      const deletedCount = await cleanupOrphanedEnvelopeSpoolFiles({
        dir,
        maxAgeMs: 60 * 60 * 1000,
      });

      expect(deletedCount).toBe(1);
      await expect(exists(spoolFile(staleSuffix))).resolves.toBe(false);
      await expect(exists(spoolFile(freshSuffix))).resolves.toBe(true);
    });

    test('resolves to 0 instead of throwing when the directory does not exist', async () => {
      await expect(
        cleanupOrphanedEnvelopeSpoolFiles({ dir: join(tmpdir(), 'papra-nonexistent-dir') }),
      ).resolves.toBe(0);
    });
  });

  describe('createEnvelopeSpoolPath', () => {
    test('honors TMPDIR and produces the expected file name pattern', () => {
      const originalTmpDir = process.env.TMPDIR;
      process.env.TMPDIR = '/custom-tmp-dir';
      try {
        expect(createEnvelopeSpoolPath()).toMatch(
          /^\/custom-tmp-dir\/papra-backup-envelope-[0-9a-f]{24}\.tmp$/,
        );
      } finally {
        if (originalTmpDir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = originalTmpDir;
        }
      }
    });
  });
});
