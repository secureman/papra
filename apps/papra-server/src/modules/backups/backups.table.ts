import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { organizationsTable } from '../organizations/organizations.table';
import { createPrimaryKeyField, createTimestampColumns } from '../shared/db/columns.helpers';
import {
  backupDestinationIdPrefix,
  backupRestoreJobIdPrefix,
  backupRunIdPrefix,
} from './backups.constants';

// One row per configured destination (an org can have several: e.g. Google Drive
// AND a WebDAV NAS). Holds the encrypted credentials + the per-destination backup
// encryption key, both wrapped with the server KEK.
export const backupDestinationsTable = sqliteTable(
  'backup_destinations',
  {
    ...createPrimaryKeyField({ prefix: backupDestinationIdPrefix }),
    ...createTimestampColumns(),

    organizationId: text('organization_id')
      .notNull()
      .references(() => organizationsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    // 'google_drive' | 'webdav' | 'ftp' — see drivers/drivers.registry.ts
    driver: text('driver').notNull(),
    displayName: text('display_name').notNull(),

    // Driver-specific, non-secret config (base URL, port, remote path, preset...),
    // stored as JSON so the settings page can show it without decrypting anything.
    settingsJson: text('settings_json').notNull().default('{}'),

    // Driver-specific secrets (refresh token, username/password...), JSON-encoded
    // then encrypted with the server KEK. Never sent to the client.
    encryptedCredentials: text('encrypted_credentials').notNull(),

    // Optional human-readable label surfaced by testConnection() (e.g. a Google
    // account email, or "alice@nextcloud.example.com").
    accountLabel: text('account_label'),

    // Per-destination symmetric key used to encrypt backup payloads before upload.
    // Wrapped with the server KEK.
    wrappedBackupKey: text('wrapped_backup_key').notNull(),
    backupKeyAlgorithm: text('backup_key_algorithm').notNull(),

    // Cached reference to the remote backup folder (Drive folder id, WebDAV/FTP
    // path...) so we don't re-resolve it on every run.
    remoteFolderRef: text('remote_folder_ref'),

    // ----- Scheduling (per-organization / per-destination, per your choice) -----
    isScheduleEnabled: integer('is_schedule_enabled', { mode: 'boolean' }).notNull().default(false),
    // JSON array of weekday ints, 0 (Sunday) to 6 (Saturday). Empty/absent = every day.
    scheduleDaysJson: text('schedule_days_json').notNull().default('[]'),
    scheduleHour: integer('schedule_hour'), // 0-23, server-local time
    scheduleMinute: integer('schedule_minute'), // 0-59
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    nextScheduledAt: integer('next_scheduled_at', { mode: 'timestamp_ms' }),

    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
  },
  (table) => [
    index('backup_destinations_organization_id_index').on(table.organizationId),
    index('backup_destinations_next_scheduled_at_index').on(table.nextScheduledAt),
  ],
);

// One row per backup run (manual or scheduled) against a given destination.
// Lifecycle: pending → uploading → succeeded | failed.
export const backupRunsTable = sqliteTable(
  'backup_runs',
  {
    ...createPrimaryKeyField({ prefix: backupRunIdPrefix }),
    ...createTimestampColumns(),

    destinationId: text('destination_id')
      .notNull()
      .references(() => backupDestinationsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizationsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    trigger: text('trigger').notNull(), // 'manual' | 'scheduled'
    status: text('status').notNull(), // 'pending' | 'uploading' | 'succeeded' | 'failed'

    remoteFileId: text('remote_file_id'),
    remoteFileName: text('remote_file_name'),

    documentsCount: integer('documents_count'),
    totalSizeBytes: integer('total_size_bytes'),

    errorMessage: text('error_message'),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('backup_runs_destination_id_created_at_index').on(table.destinationId, table.createdAt),
    index('backup_runs_status_index').on(table.status),
    // Enforces "at most one in-progress run per destination" at the database
    // level — the insert in createRun relies on this being the guard.
    uniqueIndex('backup_runs_single_in_progress_per_destination_index')
      .on(table.destinationId)
      .where(sql`${table.status} IN ('pending', 'uploading')`),
  ],
);

// One row per restore attempt (from a local run, a remote file browsed directly,
// or an uploaded file). Runs as a background job so the HTTP request that kicks
// it off can return immediately instead of blocking for however long the
// download + re-import takes — the client polls this row for progress/ETA.
// Lifecycle: pending → downloading (driver-based sources only) → restoring → succeeded | failed.
export const backupRestoreJobsTable = sqliteTable(
  'backup_restore_jobs',
  {
    ...createPrimaryKeyField({ prefix: backupRestoreJobIdPrefix }),
    ...createTimestampColumns(),

    organizationId: text('organization_id')
      .notNull()
      .references(() => organizationsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    // Null for an uploaded-file restore (no destination involved at all).
    destinationId: text('destination_id').references(() => backupDestinationsTable.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    // Set only when restoring from local run history.
    runId: text('run_id').references(() => backupRunsTable.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),

    source: text('source').notNull(), // 'run' | 'remote_file' | 'uploaded_file'
    status: text('status').notNull(), // 'pending' | 'downloading' | 'restoring' | 'succeeded' | 'failed'

    // Total is unknown until the envelope is downloaded and unpacked, hence nullable.
    totalDocumentsCount: integer('total_documents_count'),
    processedDocumentsCount: integer('processed_documents_count').notNull().default(0),

    // Byte-level progress for the download phase specifically (before the
    // manifest is even readable, so document counts aren't known yet) — lets
    // the client show real progress/ETA instead of a static "Downloading…"
    // for however long that phase takes. Populated only by drivers that
    // support streamed progress reporting; stays null otherwise.
    downloadedBytes: integer('downloaded_bytes'),
    totalBytes: integer('total_bytes'),

    restoredDocumentsCount: integer('restored_documents_count'),
    untrashedDocumentsCount: integer('untrashed_documents_count'),
    skippedDuplicatesCount: integer('skipped_duplicates_count'),

    errorMessage: text('error_message'),
    // Distinct from createdAt: this is when processing actually began (used for ETA),
    // not when the row/request was made.
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('backup_restore_jobs_organization_id_index').on(table.organizationId),
    index('backup_restore_jobs_status_index').on(table.status),
  ],
);
