import type { Database } from '../app/database/database.types';
import type {
  BackupDestination,
  BackupRestoreJob,
  BackupRestoreJobStatus,
  BackupRun,
  BackupRunStatus,
  DbInsertableBackupDestination,
  DbInsertableBackupRestoreJob,
  DbInsertableBackupRun,
} from './backups.types';
import { injectArguments } from '@corentinth/chisels';
import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { omitUndefined } from '../shared/objects';
import { backupDestinationsTable, backupRestoreJobsTable, backupRunsTable } from './backups.table';

export type BackupsRepository = ReturnType<typeof createBackupsRepository>;

export function createBackupsRepository({ db }: { db: Database }) {
  return injectArguments(
    {
      // Destinations
      createDestination,
      getDestinationById,
      listDestinationsByOrganizationId,
      updateDestination,
      deleteDestination,
      getDueScheduledDestinations,
      // Runs
      createRun,
      updateRunProgress,
      getRunById,
      listRunsByDestinationId,
      updateRunStatus,
      deleteRun,
      markStaleInProgressRunsAsFailed,
      // Restore jobs
      createRestoreJob,
      getRestoreJobById,
      updateRestoreJob,
      getActiveRestoreJobForOrganization,
      markStaleInProgressRestoreJobsAsFailed,
    },
    { db },
  );
}

// ----- Destinations -----

async function createDestination({
  destination,
  db,
}: {
  destination: DbInsertableBackupDestination;
  db: Database;
}): Promise<{ destination: BackupDestination }> {
  const [inserted] = await db.insert(backupDestinationsTable).values(destination).returning();
  return { destination: inserted! };
}

async function getDestinationById({
  destinationId,
  organizationId,
  db,
}: {
  destinationId: string;
  organizationId: string;
  db: Database;
}): Promise<{ destination: BackupDestination | undefined }> {
  const [destination] = await db
    .select()
    .from(backupDestinationsTable)
    .where(
      and(
        eq(backupDestinationsTable.id, destinationId),
        eq(backupDestinationsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  return { destination };
}

async function listDestinationsByOrganizationId({
  organizationId,
  db,
}: {
  organizationId: string;
  db: Database;
}): Promise<{ destinations: BackupDestination[] }> {
  const destinations = await db
    .select()
    .from(backupDestinationsTable)
    .where(eq(backupDestinationsTable.organizationId, organizationId))
    .orderBy(desc(backupDestinationsTable.createdAt));
  return { destinations };
}

async function updateDestination({
  destinationId,
  fields,
  db,
}: {
  destinationId: string;
  fields: Partial<
    Pick<
      BackupDestination,
      | 'displayName'
      | 'settingsJson'
      | 'encryptedCredentials'
      | 'accountLabel'
      | 'remoteFolderRef'
      | 'isScheduleEnabled'
      | 'scheduleDaysJson'
      | 'scheduleHour'
      | 'scheduleMinute'
      | 'lastRunAt'
      | 'nextScheduledAt'
      | 'isEnabled'
    >
  >;
  db: Database;
}): Promise<{ destination: BackupDestination }> {
  const [updated] = await db
    .update(backupDestinationsTable)
    .set({ ...omitUndefined(fields), updatedAt: new Date() })
    .where(eq(backupDestinationsTable.id, destinationId))
    .returning();
  return { destination: updated! };
}

async function deleteDestination({
  destinationId,
  organizationId,
  db,
}: {
  destinationId: string;
  organizationId: string;
  db: Database;
}): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(backupDestinationsTable)
    .where(
      and(
        eq(backupDestinationsTable.id, destinationId),
        eq(backupDestinationsTable.organizationId, organizationId),
      ),
    )
    .returning({ id: backupDestinationsTable.id });
  return { deleted: result.length > 0 };
}

// Used by the scheduler tick: every destination with scheduling on whose
// nextScheduledAt has passed. The usecase layer recomputes nextScheduledAt after
// each run (whether it fires or not), so this is a plain timestamp comparison.
async function getDueScheduledDestinations({
  now,
  db,
}: {
  now: Date;
  db: Database;
}): Promise<{ destinations: BackupDestination[] }> {
  const destinations = await db
    .select()
    .from(backupDestinationsTable)
    .where(
      and(
        eq(backupDestinationsTable.isScheduleEnabled, true),
        eq(backupDestinationsTable.isEnabled, true),
        isNotNull(backupDestinationsTable.nextScheduledAt),
        lte(backupDestinationsTable.nextScheduledAt, now),
      ),
    );
  return { destinations };
}

// ----- Runs -----

async function createRun({
  run,
  db,
}: {
  run: DbInsertableBackupRun;
  db: Database;
}): Promise<{ run: BackupRun | undefined }> {
  // The insert itself is the concurrency guard: a partial unique index on
  // (destination_id) WHERE status IN ('pending','uploading') makes a second
  // simultaneous insert a no-op. Returns undefined when the destination
  // already has an in-progress run.
  const [inserted] = await db.insert(backupRunsTable).values(run).onConflictDoNothing().returning();
  return { run: inserted };
}

async function getRunById({
  runId,
  organizationId,
  db,
}: {
  runId: string;
  organizationId: string;
  db: Database;
}): Promise<{ run: BackupRun | undefined }> {
  const [run] = await db
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.id, runId), eq(backupRunsTable.organizationId, organizationId)))
    .limit(1);
  return { run };
}

async function listRunsByDestinationId({
  destinationId,
  limit = 20,
  db,
}: {
  destinationId: string;
  limit?: number;
  db: Database;
}): Promise<{ runs: BackupRun[] }> {
  const runs = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.destinationId, destinationId))
    .orderBy(desc(backupRunsTable.createdAt))
    .limit(limit);
  return { runs };
}

async function updateRunStatus({
  runId,
  status,
  fields = {},
  db,
}: {
  runId: string;
  status: BackupRunStatus;
  fields?: Partial<
    Pick<
      BackupRun,
      | 'remoteFileId'
      | 'remoteFileName'
      | 'documentsCount'
      | 'totalSizeBytes'
      | 'totalRawBytes'
      | 'processedDocumentsCount'
      | 'processedBytes'
      | 'uploadedBytes'
      | 'errorMessage'
      | 'completedAt'
    >
  >;
  db: Database;
}): Promise<void> {
  await db
    .update(backupRunsTable)
    // updatedAt is bumped on every write so it doubles as a heartbeat: the
    // stale-run cleanup judges liveness by last write, not creation time.
    .set({ status, ...omitUndefined(fields), updatedAt: new Date() })
    .where(eq(backupRunsTable.id, runId));
}

// Progress-only write, no status change — used from the tight loops inside
// the packaging/upload phases where a write happens every N milliseconds and
// re-stating `status` each time would just be noise (and risk racing a
// concurrent status transition written from elsewhere in the pipeline).
async function updateRunProgress({
  runId,
  fields,
  db,
}: {
  runId: string;
  fields: Partial<Pick<BackupRun, 'processedDocumentsCount' | 'processedBytes' | 'uploadedBytes'>>;
  db: Database;
}): Promise<void> {
  // updatedAt bump = heartbeat, same as updateRunStatus above.
  await db
    .update(backupRunsTable)
    .set({ ...omitUndefined(fields), updatedAt: new Date() })
    .where(eq(backupRunsTable.id, runId));
}

async function deleteRun({
  runId,
  db,
}: {
  runId: string;
  db: Database;
}): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(backupRunsTable)
    .where(eq(backupRunsTable.id, runId))
    .returning({ id: backupRunsTable.id });
  return { deleted: result.length > 0 };
}

// Marks runs stuck in an in-progress status past the stale threshold as failed.
// Liveness is judged by updatedAt (last write), not createdAt: a run whose
// pipeline is still writing progress is never reaped, while a row orphaned by
// a dead process (no more writes) ages out normally. The caller picks which
// in-progress statuses to reap — 'pending'/'packaging'/'uploading' use the 24h
// threshold, 'ready_for_download' a short one (see backups.constants).
async function markStaleInProgressRunsAsFailed({
  destinationId,
  statuses,
  staleBefore,
  errorMessage,
  db,
}: {
  destinationId: string;
  statuses: BackupRunStatus[];
  staleBefore: Date;
  errorMessage: string;
  db: Database;
}): Promise<{ markedCount: number }> {
  const result = await db
    .update(backupRunsTable)
    .set({ status: 'failed', errorMessage, completedAt: new Date() })
    .where(
      and(
        eq(backupRunsTable.destinationId, destinationId),
        inArray(backupRunsTable.status, statuses),
        lte(backupRunsTable.updatedAt, staleBefore),
      ),
    )
    .returning({ id: backupRunsTable.id });
  return { markedCount: result.length };
}

// ----- Restore jobs -----
// Same fire-and-forget-then-poll shape as backup runs above, but for the
// restore direction: a job row is created up front so the HTTP handler can
// return instantly with its id, and the background pipeline keeps writing
// progress to it as it works through the manifest.

async function createRestoreJob({
  job,
  db,
}: {
  job: DbInsertableBackupRestoreJob;
  db: Database;
}): Promise<{ job: BackupRestoreJob }> {
  const [inserted] = await db.insert(backupRestoreJobsTable).values(job).returning();
  return { job: inserted! };
}

async function getRestoreJobById({
  jobId,
  organizationId,
  db,
}: {
  jobId: string;
  organizationId: string;
  db: Database;
}): Promise<{ job: BackupRestoreJob | undefined }> {
  const [job] = await db
    .select()
    .from(backupRestoreJobsTable)
    .where(
      and(
        eq(backupRestoreJobsTable.id, jobId),
        eq(backupRestoreJobsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  return { job };
}

async function updateRestoreJob({
  jobId,
  status,
  fields = {},
  db,
}: {
  jobId: string;
  status?: BackupRestoreJobStatus;
  fields?: Partial<
    Pick<
      BackupRestoreJob,
      | 'totalDocumentsCount'
      | 'processedDocumentsCount'
      | 'downloadedBytes'
      | 'totalBytes'
      | 'restoredDocumentsCount'
      | 'untrashedDocumentsCount'
      | 'skippedDuplicatesCount'
      | 'errorMessage'
      | 'startedAt'
      | 'completedAt'
    >
  >;
  db: Database;
}): Promise<void> {
  await db
    .update(backupRestoreJobsTable)
    .set({ ...(status ? { status } : {}), ...omitUndefined(fields), updatedAt: new Date() })
    .where(eq(backupRestoreJobsTable.id, jobId));
}

// Powers the cog-wheel indicator: whatever page the user is on, or after a
// refresh/navigation away and back, this is how the UI finds "oh, there's
// still a restore running" without having to have kept the jobId around.
async function getActiveRestoreJobForOrganization({
  organizationId,
  db,
}: {
  organizationId: string;
  db: Database;
}): Promise<{ job: BackupRestoreJob | undefined }> {
  const [job] = await db
    .select()
    .from(backupRestoreJobsTable)
    .where(
      and(
        eq(backupRestoreJobsTable.organizationId, organizationId),
        inArray(backupRestoreJobsTable.status, ['pending', 'downloading', 'restoring']),
      ),
    )
    .orderBy(desc(backupRestoreJobsTable.createdAt))
    .limit(1);
  return { job };
}

async function markStaleInProgressRestoreJobsAsFailed({
  organizationId,
  staleBefore,
  errorMessage,
  db,
}: {
  organizationId: string;
  staleBefore: Date;
  errorMessage: string;
  db: Database;
}): Promise<{ markedCount: number }> {
  const result = await db
    .update(backupRestoreJobsTable)
    .set({ status: 'failed', errorMessage, completedAt: new Date() })
    .where(
      and(
        eq(backupRestoreJobsTable.organizationId, organizationId),
        inArray(backupRestoreJobsTable.status, ['pending', 'downloading', 'restoring']),
        // Judge liveness by updatedAt (bumped on every progress write), not
        // createdAt — a legitimately long restore that's still reporting
        // progress must never be reaped by a newer job starting up.
        lte(backupRestoreJobsTable.updatedAt, staleBefore),
      ),
    )
    .returning({ id: backupRestoreJobsTable.id });
  return { markedCount: result.length };
}
