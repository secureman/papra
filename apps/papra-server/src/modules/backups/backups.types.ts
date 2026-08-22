import type { Expand } from '@corentinth/chisels';
import type { BackupDriverName } from './drivers/drivers.registry';
import type {
  backupDestinationsTable,
  backupRestoreJobsTable,
  backupRunsTable,
} from './backups.table';

export type BackupDestination = Expand<typeof backupDestinationsTable.$inferSelect>;
export type DbInsertableBackupDestination = Expand<typeof backupDestinationsTable.$inferInsert>;

export type BackupRun = Expand<typeof backupRunsTable.$inferSelect>;
export type DbInsertableBackupRun = Expand<typeof backupRunsTable.$inferInsert>;

export type BackupRestoreJob = Expand<typeof backupRestoreJobsTable.$inferSelect>;
export type DbInsertableBackupRestoreJob = Expand<typeof backupRestoreJobsTable.$inferInsert>;
export type BackupRestoreJobStatus =
  | 'pending'
  | 'downloading'
  | 'restoring'
  | 'succeeded'
  | 'failed';
export type BackupRestoreJobSource = 'run' | 'remote_file' | 'uploaded_file';

// Public-facing shape: never includes encryptedCredentials or wrappedBackupKey.
export type PublicBackupDestination = Omit<
  BackupDestination,
  'encryptedCredentials' | 'wrappedBackupKey'
> & {
  driver: BackupDriverName;
};

export type BackupRunStatus =
  | 'pending'
  | 'packaging'
  | 'uploading'
  | 'ready_for_download' // local-folder destinations only, see local driver
  | 'succeeded'
  | 'failed';
export type BackupRunTrigger = 'manual' | 'scheduled';

export type BackupSchedule = {
  isEnabled: boolean;
  days: number[]; // 0 (Sunday) - 6 (Saturday), empty = every day
  hour: number | null;
  minute: number | null;
};
