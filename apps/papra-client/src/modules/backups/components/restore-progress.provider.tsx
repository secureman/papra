import type { ParentComponent } from 'solid-js';
import type { BackupRestoreJob } from '../backups.types';
import { formatBytes, safely } from '@corentinth/chisels';
import {
  createContext,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  useContext,
} from 'solid-js';
import { queryClient } from '@/modules/shared/query/query-client';
import { createToast } from '@/modules/ui/components/sonner';
import { fetchActiveRestoreJob, fetchRestoreJob } from '../backups.services';

// How often we re-poll the job row while it's in progress. Matches the
// existing backup-run polling interval elsewhere in this module.
const POLL_INTERVAL_MS = 2000;
// How often the "now" ticker advances, purely so the ETA label counts down
// smoothly between polls instead of jumping every 2s.
const CLOCK_TICK_MS = 1000;
// Safety net so a browser tab left open forever doesn't poll indefinitely —
// the job itself keeps running server-side regardless; reopening the page (or
// any page in this org) picks it back up via the "active job" lookup below.
const MAX_POLL_DURATION_MS = 60 * 60 * 1000;

const ACTIVE_STATUSES = new Set<BackupRestoreJob['status']>([
  'pending',
  'downloading',
  'restoring',
]);

function invalidateBackupsQueries({ organizationId }: { organizationId: string }) {
  void queryClient.invalidateQueries({
    queryKey: ['organizations', organizationId, 'backups'],
  });
}

function describeOutcome({ job }: { job: BackupRestoreJob }) {
  const parts = [
    `Restored ${job.restoredDocumentsCount ?? 0}/${job.totalDocumentsCount ?? 0} documents`,
  ];
  if (job.untrashedDocumentsCount) {
    parts.push(`${job.untrashedDocumentsCount} untrashed`);
  }
  if (job.skippedDuplicatesCount) {
    parts.push(`${job.skippedDuplicatesCount} already present`);
  }
  return `${parts[0]} (${parts.slice(1).join(', ')})`.replace(' ()', '');
}

// Rough ETA from average throughput so far — good enough to be useful without
// pretending to a precision the data doesn't have.
function formatEtaLabel(remainingMs: number): string {
  if (remainingMs < 5000) {
    return 'almost done';
  }
  if (remainingMs < 60_000) {
    return `~${Math.ceil(remainingMs / 1000)}s left`;
  }
  if (remainingMs < 60 * 60_000) {
    return `~${Math.ceil(remainingMs / 60_000)}m left`;
  }
  return `~${Math.ceil(remainingMs / (60 * 60_000))}h left`;
}

// Not every driver reports byte progress (some just buffer the whole download
// with no size known up front) — in that case this falls back to a plain
// "still downloading" label with no percent, same as before.
function estimateDownloadEta({ job, now }: { job: BackupRestoreJob; now: number }): {
  label: string;
  percent: number | null;
} {
  const { downloadedBytes, totalBytes, startedAt } = job;

  if (downloadedBytes === null || downloadedBytes === 0) {
    return { label: 'Downloading backup…', percent: null };
  }

  const sizeLabel = totalBytes
    ? `${formatBytes({ bytes: downloadedBytes })} / ${formatBytes({ bytes: totalBytes })}`
    : formatBytes({ bytes: downloadedBytes });

  if (!totalBytes || !startedAt) {
    return { label: `Downloading… ${sizeLabel}`, percent: null };
  }

  const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
  const elapsedMs = Math.max(1, now - startedAt.getTime());
  const bytesPerMs = downloadedBytes / elapsedMs;
  const remainingMs = Math.max(0, (totalBytes - downloadedBytes) / bytesPerMs);

  return { label: `${sizeLabel} · ${formatEtaLabel(remainingMs)}`, percent };
}

export function estimateRestoreEta({ job, now }: { job: BackupRestoreJob; now: number }): {
  label: string;
  percent: number | null;
} {
  const total = job.totalDocumentsCount;
  const processed = job.processedDocumentsCount;

  if (job.status === 'pending') {
    return { label: 'Starting…', percent: null };
  }
  if (job.status === 'downloading') {
    return estimateDownloadEta({ job, now });
  }
  if (!total || total === 0) {
    return { label: 'Preparing…', percent: null };
  }

  const percent = Math.min(100, Math.round((processed / total) * 100));

  if (!job.startedAt || processed === 0) {
    return { label: `${processed}/${total} documents`, percent };
  }

  const elapsedMs = Math.max(1, now - job.startedAt.getTime());
  const perDocumentMs = elapsedMs / processed;
  const remainingMs = Math.max(0, (total - processed) * perDocumentMs);

  return { label: `${processed}/${total} documents · ${formatEtaLabel(remainingMs)}`, percent };
}

type RestoreProgressContextValue = {
  activeJob: () => BackupRestoreJob | null;
  now: () => number;
  // Called right after a restore request returns a jobId, so the indicator
  // starts polling immediately instead of waiting for the next mount-time check.
  registerRestoreJob: (args: { organizationId: string; jobId: string }) => void;
};

const RestoreProgressContext = createContext<RestoreProgressContextValue>();

export function useRestoreProgress() {
  const context = useContext(RestoreProgressContext);
  if (!context) {
    throw new Error('RestoreProgressContext not found');
  }
  return context;
}

export const RestoreProgressProvider: ParentComponent<{ organizationId: string }> = (props) => {
  const [getActiveJob, setActiveJob] = createSignal<BackupRestoreJob | null>(null);
  const [getNow, setNow] = createSignal(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let pollStopTimeout: ReturnType<typeof setTimeout> | null = null;

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
    if (pollStopTimeout) {
      clearTimeout(pollStopTimeout);
      pollStopTimeout = null;
    }
  };

  const settleJob = ({
    job,
    organizationId,
  }: {
    job: BackupRestoreJob;
    organizationId: string;
  }) => {
    stopPolling();
    setActiveJob(null);
    invalidateBackupsQueries({ organizationId });

    if (job.status === 'succeeded') {
      createToast({ type: 'success', message: describeOutcome({ job }) });
    } else if (job.status === 'failed') {
      createToast({
        type: 'error',
        message: job.errorMessage ? `Restore failed: ${job.errorMessage}` : 'Restore failed',
      });
    }
  };

  const poll = async ({ organizationId, jobId }: { organizationId: string; jobId: string }) => {
    const [result, error] = await safely(fetchRestoreJob({ organizationId, jobId }));
    if (error) {
      // A transient network hiccup shouldn't kill the indicator — just try
      // again on the next tick.
      return;
    }

    const { job } = result;
    setActiveJob(job);

    if (!ACTIVE_STATUSES.has(job.status)) {
      settleJob({ job, organizationId });
    }
  };

  const startPolling = ({ organizationId, jobId }: { organizationId: string; jobId: string }) => {
    stopPolling();

    void poll({ organizationId, jobId });
    pollTimer = setInterval(() => void poll({ organizationId, jobId }), POLL_INTERVAL_MS);
    clockTimer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    pollStopTimeout = setTimeout(() => stopPolling(), MAX_POLL_DURATION_MS);
  };

  const registerRestoreJob = ({
    organizationId,
    jobId,
  }: {
    organizationId: string;
    jobId: string;
  }) => {
    startPolling({ organizationId, jobId });
  };

  // On mount (and whenever the org changes), check whether a restore is
  // already running — covers a page refresh or navigating back after
  // kicking one off earlier.
  createEffect(
    on(
      () => props.organizationId,
      (organizationId) => {
        stopPolling();
        setActiveJob(null);

        void (async () => {
          const [result, error] = await safely(fetchActiveRestoreJob({ organizationId }));
          if (error || !result.job) {
            return;
          }
          startPolling({ organizationId, jobId: result.job.id });
        })();
      },
    ),
  );

  onMount(() => {
    onCleanup(() => stopPolling());
  });

  return (
    <RestoreProgressContext.Provider
      value={{ activeJob: getActiveJob, now: getNow, registerRestoreJob }}
    >
      {props.children}
    </RestoreProgressContext.Provider>
  );
};
