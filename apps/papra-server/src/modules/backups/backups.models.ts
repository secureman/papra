import type { BackupSchedule } from './backups.types';

// Archive entry names ride in ustar tar headers whose final path segment can't
// exceed 100 bytes (see splitUstarPath in backups.packager.service.ts). Entry
// names are `{documentId}-{sanitized original name}` under a `files/` folder,
// so the whole basename must stay within that budget.
export const BACKUP_ENTRY_FILE_NAME_MAX_LENGTH = 100;

// Builds a tar-safe archive entry name for a backed-up document. Uniqueness
// comes from the document id prefix (the manifest keeps the true name), so
// when a sanitized original name doesn't fit it gets trimmed — keeping the
// extension so restored files stay recognizable. Sanitization collapses
// everything outside [\w.-] to '_', which is ASCII-only, hence string length
// equals byte length.
export function buildBackupEntryFileName({
  documentId,
  originalName,
}: {
  documentId: string;
  originalName: string;
}): string {
  const sanitized = originalName.replace(/[^\w.-]/g, '_') || 'document';
  const fullName = `${documentId}-${sanitized}`;

  if (fullName.length <= BACKUP_ENTRY_FILE_NAME_MAX_LENGTH) {
    return fullName;
  }

  // Preserve the extension (text after the last dot) when there's room for it.
  const dotIndex = sanitized.lastIndexOf('.');
  const extension = dotIndex > 0 ? sanitized.slice(dotIndex) : '';
  const basePart = dotIndex > 0 ? sanitized.slice(0, dotIndex) : sanitized;
  const baseBudget = Math.max(
    1,
    BACKUP_ENTRY_FILE_NAME_MAX_LENGTH - documentId.length - 1 - extension.length,
  );
  const trimmedBase = basePart.slice(0, baseBudget);

  // Belt and braces for pathological extensions longer than the whole budget:
  // hard-trim to the limit with the document id prefix kept intact.
  return `${documentId}-${trimmedBase}${extension}`.slice(0, BACKUP_ENTRY_FILE_NAME_MAX_LENGTH);
}

// Finds the next Date (>= `from`) matching the schedule's days-of-week + time.
// Server-local time throughout — kept simple deliberately (see backups.config.ts
// doc comment); if you run the server in a different timezone than you want
// backups scheduled in, that's a config concern, not something the picker needs
// to model.
export function computeNextScheduledAt({
  schedule,
  from,
}: {
  schedule: BackupSchedule;
  from: Date;
}): Date | null {
  if (!schedule.isEnabled) {
    return null;
  }

  const hour = schedule.hour ?? 3;
  const minute = schedule.minute ?? 0;
  const days = schedule.days.length > 0 ? schedule.days : [0, 1, 2, 3, 4, 5, 6];

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);

    if (candidate <= from) {
      continue;
    }
    if (days.includes(candidate.getDay())) {
      return candidate;
    }
  }

  // Unreachable in practice (checked a full week), but keep the type honest.
  return null;
}

export function parseScheduleDays(scheduleDaysJson: string): number[] {
  try {
    const parsed = JSON.parse(scheduleDaysJson) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return [];
}
