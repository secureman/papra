import type { AsDto } from '../shared/http/http-client.types';
import type {
  BackupDestination,
  BackupDriverInfo,
  BackupDriverName,
  BackupRestoreJob,
  BackupRun,
  BackupSchedule,
} from './backups.types';
import { apiClient } from '../shared/http/api-client';
import { getFormData } from '../shared/http/http-client.models';

const DESTINATIONS_PATH = (orgId: string) => `/api/organizations/${orgId}/backups/destinations`;

function coerceDestinationDates(d: AsDto<BackupDestination>): BackupDestination {
  return {
    ...d,
    lastRunAt: d.lastRunAt ? new Date(d.lastRunAt) : null,
    nextScheduledAt: d.nextScheduledAt ? new Date(d.nextScheduledAt) : null,
    createdAt: new Date(d.createdAt),
  };
}

function coerceRunDates(r: AsDto<BackupRun>): BackupRun {
  return {
    ...r,
    createdAt: new Date(r.createdAt),
    completedAt: r.completedAt ? new Date(r.completedAt) : null,
  };
}

function coerceRestoreJobDates(j: AsDto<BackupRestoreJob>): BackupRestoreJob {
  return {
    ...j,
    startedAt: j.startedAt ? new Date(j.startedAt) : null,
    completedAt: j.completedAt ? new Date(j.completedAt) : null,
    createdAt: new Date(j.createdAt),
  };
}

export async function fetchBackupDrivers() {
  return apiClient<{ isConfigured: boolean; drivers: BackupDriverInfo[] }>({
    path: '/api/backups/drivers',
    method: 'GET',
  });
}

export async function testBackupDestinationConnection({
  organizationId,
  driver,
  credentials,
  settings,
}: {
  organizationId: string;
  driver: BackupDriverName;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}) {
  return apiClient<{ accountLabel?: string }>({
    path: `${DESTINATIONS_PATH(organizationId)}/test-connection`,
    method: 'POST',
    body: { driver, credentials, settings },
  });
}

export async function createBackupDestination({
  organizationId,
  driver,
  displayName,
  credentials,
  settings,
}: {
  organizationId: string;
  driver: BackupDriverName;
  displayName: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}) {
  return apiClient<{ destinationId: string }>({
    path: DESTINATIONS_PATH(organizationId),
    method: 'POST',
    body: { driver, displayName, credentials, settings },
  });
}

// Google Drive doesn't take a credentials form — it's OAuth. This kicks off the
// flow; the caller should redirect window.location to the returned URL.
export async function startGoogleDriveConnect({
  organizationId,
  displayName,
}: {
  organizationId: string;
  displayName?: string;
}) {
  return apiClient<{ authorizationUrl: string }>({
    path: `/api/organizations/${organizationId}/backups/google-drive/connect`,
    method: 'POST',
    body: { displayName },
  });
}

export async function listBackupDestinations({ organizationId }: { organizationId: string }) {
  const { destinations } = await apiClient<{ destinations: AsDto<BackupDestination>[] }>({
    path: DESTINATIONS_PATH(organizationId),
    method: 'GET',
  });
  return { destinations: destinations.map(coerceDestinationDates) };
}

export async function renameBackupDestination({
  organizationId,
  destinationId,
  displayName,
}: {
  organizationId: string;
  destinationId: string;
  displayName: string;
}) {
  return apiClient<{ renamed: boolean }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}`,
    method: 'PATCH',
    body: { displayName },
  });
}

export async function updateBackupSchedule({
  organizationId,
  destinationId,
  schedule,
}: {
  organizationId: string;
  destinationId: string;
  schedule: BackupSchedule;
}) {
  return apiClient<{ nextScheduledAt: string | null }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/schedule`,
    method: 'PUT',
    body: schedule,
  });
}

export async function deleteBackupDestination({
  organizationId,
  destinationId,
}: {
  organizationId: string;
  destinationId: string;
}) {
  return apiClient<{ deleted: boolean }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}`,
    method: 'DELETE',
  });
}

export async function listBackupRuns({
  organizationId,
  destinationId,
}: {
  organizationId: string;
  destinationId: string;
}) {
  const { runs } = await apiClient<{ runs: AsDto<BackupRun>[] }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/runs`,
    method: 'GET',
  });
  return { runs: runs.map(coerceRunDates) };
}

export async function runBackupNow({
  organizationId,
  destinationId,
}: {
  organizationId: string;
  destinationId: string;
}) {
  return apiClient<{ runId: string }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/runs`,
    method: 'POST',
  });
}

// Claims the envelope of a local-destination run once it's sitting at
// 'ready_for_download' — one-shot, same request shape as fetchBackupCopy.
export async function fetchReadyBackupRun({
  organizationId,
  destinationId,
  runId,
}: {
  organizationId: string;
  destinationId: string;
  runId: string;
}) {
  const blob = await apiClient({
    method: 'GET',
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/runs/${runId}/download`,
    responseType: 'blob',
  });
  return blob;
}

export async function deleteBackupRun({
  organizationId,
  destinationId,
  runId,
}: {
  organizationId: string;
  destinationId: string;
  runId: string;
}) {
  return apiClient<{ deleted: boolean }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/runs/${runId}`,
    method: 'DELETE',
  });
}

export async function listRemoteBackupFiles({
  organizationId,
  destinationId,
}: {
  organizationId: string;
  destinationId: string;
}) {
  return apiClient<{
    files: { remoteFileId: string; name: string; size?: number; modifiedAt?: string }[];
  }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/remote-files`,
    method: 'GET',
  });
}

export async function restoreFromRemoteFile({
  organizationId,
  destinationId,
  remoteFileId,
}: {
  organizationId: string;
  destinationId: string;
  remoteFileId: string;
}) {
  return apiClient<{ jobId: string }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/remote-files/restore`,
    method: 'POST',
    body: { remoteFileId },
  });
}

export async function restoreBackupRun({
  organizationId,
  destinationId,
  runId,
}: {
  organizationId: string;
  destinationId: string;
  runId: string;
}) {
  return apiClient<{ jobId: string }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/runs/${runId}/restore`,
    method: 'POST',
  });
}

// No destination, no credentials, no connection of any kind — you already have
// the backup file (copied off wherever) and just upload it directly. The
// upload itself is still a normal request (the file has to reach the server
// either way); only the re-import step afterwards runs as a background job.
export async function restoreFromUploadedFile({
  organizationId,
  file,
}: {
  organizationId: string;
  file: File;
}) {
  return apiClient<{ jobId: string }>({
    path: `/api/organizations/${organizationId}/backups/recover-from-file`,
    method: 'POST',
    body: getFormData({ file }),
    timeout: 120000, // just needs to cover the upload itself, not the restore anymore
  });
}

// A one-off manual export straight to the browser — no destination involved,
// nothing persisted server-side, not tracked in any run history.
export async function fetchBackupCopy({ organizationId }: { organizationId: string }) {
  const blob = await apiClient({
    method: 'GET',
    path: `/api/organizations/${organizationId}/backups/download-copy`,
    responseType: 'blob',
  });
  return blob;
}

export async function verifyBackupRun({
  organizationId,
  destinationId,
  runId,
}: {
  organizationId: string;
  destinationId: string;
  runId: string;
}) {
  return apiClient<{
    valid: boolean;
    totalDocuments: number;
    validDocuments: number;
    invalidDocuments: number;
    errors: string[];
  }>({
    path: `${DESTINATIONS_PATH(organizationId)}/${destinationId}/runs/${runId}/verify`,
    method: 'POST',
  });
}

// ----- Restore job polling (drives the global progress indicator) -----

export async function fetchRestoreJob({
  organizationId,
  jobId,
}: {
  organizationId: string;
  jobId: string;
}) {
  const { job } = await apiClient<{ job: AsDto<BackupRestoreJob> }>({
    path: `/api/organizations/${organizationId}/backups/restore-jobs/job/${jobId}`,
    method: 'GET',
  });
  return { job: coerceRestoreJobDates(job) };
}

// Lets the indicator pick up an in-progress restore on page load or after
// navigating back, without needing to have kept the jobId in memory.
export async function fetchActiveRestoreJob({ organizationId }: { organizationId: string }) {
  const { job } = await apiClient<{ job: AsDto<BackupRestoreJob> | null }>({
    path: `/api/organizations/${organizationId}/backups/restore-jobs/active`,
    method: 'GET',
  });
  return { job: job ? coerceRestoreJobDates(job) : null };
}
