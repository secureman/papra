export type BackupDriverName = 'google_drive' | 'webdav' | 'ftp' | 'local';

export type BackupSchedule = {
  isEnabled: boolean;
  days: number[]; // 0 (Sunday) - 6 (Saturday)
  hour: number | null;
  minute: number | null;
};

export type BackupDestination = {
  id: string;
  driver: BackupDriverName;
  displayName: string;
  settings: Record<string, unknown>;
  accountLabel: string | null;
  isEnabled: boolean;
  schedule: BackupSchedule;
  lastRunAt: Date | null;
  nextScheduledAt: Date | null;
  createdAt: Date;
};

export type BackupRunStatus = 'pending' | 'uploading' | 'succeeded' | 'failed';

export type BackupRun = {
  id: string;
  destinationId: string;
  trigger: 'manual' | 'scheduled';
  status: BackupRunStatus;
  remoteFileName: string | null;
  documentsCount: number | null;
  totalSizeBytes: number | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type BackupDriverInfo = {
  name: BackupDriverName;
  isConfigured: boolean;
};

export type BackupRestoreJobStatus =
  | 'pending'
  | 'downloading'
  | 'restoring'
  | 'succeeded'
  | 'failed';

export type BackupRestoreJobSource = 'run' | 'remote_file' | 'uploaded_file';

export type BackupRestoreJob = {
  id: string;
  organizationId: string;
  destinationId: string | null;
  runId: string | null;
  source: BackupRestoreJobSource;
  status: BackupRestoreJobStatus;
  totalDocumentsCount: number | null;
  processedDocumentsCount: number;
  restoredDocumentsCount: number | null;
  untrashedDocumentsCount: number | null;
  skippedDuplicatesCount: number | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};
