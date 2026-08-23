import { describe, expect, test } from 'vitest';
import {
  buildBackupEntryFileName,
  computeNextScheduledAt,
  parseScheduleDays,
} from './backups.models';
import type { BackupSchedule } from './backups.types';

function createSchedule(overrides: Partial<BackupSchedule> = {}): BackupSchedule {
  return {
    isEnabled: true,
    days: [],
    hour: 3,
    minute: 0,
    ...overrides,
  };
}

describe('backups models', () => {
  describe('buildBackupEntryFileName', () => {
    const documentId = 'doc_cn0m8f2h8aefhx8e66sjjh6e';

    test('sanitizes unsafe characters and keeps short names intact', () => {
      expect(buildBackupEntryFileName({ documentId, originalName: 'my invoice (2026).pdf' })).toBe(
        `${documentId}-my_invoice__2026_.pdf`,
      );
    });

    test('trims over-long names to the ustar limit while keeping the extension and id prefix', () => {
      // The exact case from a real backup failure: a very long original file
      // name collapses into underscores and blows past the tar name field.
      const longName = `${'_'.repeat(22)}-${'_'.repeat(45)}.pdf`.replace('-', '_');
      const fileName = buildBackupEntryFileName({
        documentId,
        originalName: `${'very-long-'.repeat(20)}.pdf`,
      });

      expect(fileName.length).toBeLessThanOrEqual(100);
      expect(fileName.startsWith(`${documentId}-`)).toBe(true);
      expect(fileName.endsWith('.pdf')).toBe(true);
      expect(longName.length).toBeGreaterThan(0); // sanity
    });

    test('trims extension-less names too', () => {
      const fileName = buildBackupEntryFileName({
        documentId,
        originalName: 'x'.repeat(200),
      });

      expect(fileName.length).toBeLessThanOrEqual(100);
      expect(fileName.startsWith(`${documentId}-`)).toBe(true);
    });

    test('never exceeds the limit even with a pathological extension', () => {
      const fileName = buildBackupEntryFileName({
        documentId,
        originalName: `a.${'.'.repeat(150)}`,
      });

      expect(fileName.length).toBeLessThanOrEqual(100);
      expect(fileName.startsWith(documentId)).toBe(true);
    });
  });
  describe('computeNextScheduledAt', () => {
    test('returns null when the schedule is disabled', () => {
      expect(
        computeNextScheduledAt({
          schedule: createSchedule({ isEnabled: false }),
          from: new Date('2026-08-22T10:00:00'),
        }),
      ).toBeNull();
    });

    test('returns the same day when the time is still ahead', () => {
      const next = computeNextScheduledAt({
        schedule: createSchedule(),
        from: new Date('2026-08-22T01:00:00'),
      });

      expect(next).toEqual(new Date('2026-08-22T03:00:00'));
    });

    test("rolls over to tomorrow when today's slot has passed", () => {
      const next = computeNextScheduledAt({
        schedule: createSchedule(),
        from: new Date('2026-08-22T03:00:00'),
      });

      expect(next).toEqual(new Date('2026-08-23T03:00:00'));
    });

    test('skips to the next selected day of the week', () => {
      // 2026-08-22 is a Saturday. Monday-only schedule → next occurrence is the 24th.
      const next = computeNextScheduledAt({
        schedule: createSchedule({ days: [1] }),
        from: new Date('2026-08-22T10:00:00'),
      });

      expect(next).toEqual(new Date('2026-08-24T03:00:00'));
    });

    test('treats an empty days array as every day', () => {
      // Saturday 10:00 with default 03:00 slot → Sunday 03:00.
      const next = computeNextScheduledAt({
        schedule: createSchedule({ days: [] }),
        from: new Date('2026-08-22T10:00:00'),
      });

      expect(next).toEqual(new Date('2026-08-23T03:00:00'));
    });

    test('defaults to 03:00 when hour/minute are null', () => {
      const next = computeNextScheduledAt({
        schedule: createSchedule({ hour: null, minute: null }),
        from: new Date('2026-08-22T01:00:00'),
      });

      expect(next).toEqual(new Date('2026-08-22T03:00:00'));
    });

    test('never returns a candidate in the past or equal to `from`', () => {
      const from = new Date('2026-08-22T03:00:00');
      const next = computeNextScheduledAt({ schedule: createSchedule(), from });

      expect(next!.getTime()).toBeGreaterThan(from.getTime());
    });
  });

  describe('parseScheduleDays', () => {
    test('parses a valid days JSON array', () => {
      expect(parseScheduleDays('[1,3,5]')).toEqual([1, 3, 5]);
    });

    test.each([
      ['invalid json', 'not json'],
      ['non-array json', '{"a":1}'],
      ['out-of-range values', '[0,7]'],
      ['non-number entries', '["monday"]'],
    ])('falls back to an empty array for %s', (_label, input) => {
      expect(parseScheduleDays(input)).toEqual([]);
    });
  });
});
