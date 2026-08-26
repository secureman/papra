// Local-folder destinations don't have anywhere server-side to put the
// envelope — the whole point is that it goes to the *client's device* (see
// drivers/local/local.driver.ts). Since runBackupPipeline is a fire-and-forget
// background job with no HTTP response left to stream the file down, we hold
// the finished envelope here just long enough for the client's next poll to
// notice status === 'ready_for_download' and fetch it.
//
// The envelope lives in a spool FILE on disk (see backups.envelope-spool.ts),
// not memory — holding hundreds of MB of Buffer alive was part of what made
// backup runs OOM small servers. This service OWNS the file once handed over:
// expiry, discard() and a successful claim all delete it.
//
// This is intentionally NOT durable storage: if the server restarts, or nobody
// claims the file within EXPIRY_MS, the run is marked failed and the spool
// file is deleted. Local backups are meant to be an immediate, attended action
// (you tap "Run backup", your client saves the file) — not a fire-and-forget
// you check on the next day.

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

type PendingLocalDownload = {
  filePath: string;
  size: number;
  fileName: string;
  organizationId: string;
  timeout: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingLocalDownload>();

export function createLocalDeliveryService() {
  return {
    // Registers a spool file for a run and returns once it either gets
    // claimed via takeReadyDownload() or expires. `onExpire` lets the caller
    // mark the run row as failed so it doesn't sit at "ready_for_download"
    // forever if nobody was there to receive it. Ownership of the file
    // transfers to this service — it is deleted on expiry/claim/discard.
    holdForDownload({
      runId,
      filePath,
      size,
      fileName,
      organizationId,
      onExpire,
    }: {
      runId: string;
      filePath: string;
      size: number;
      fileName: string;
      organizationId: string;
      onExpire: () => void;
    }): void {
      const timeout = setTimeout(() => {
        pending.delete(runId);
        void import('node:fs/promises').then(({ unlink }) => unlink(filePath).catch(() => {}));
        onExpire();
      }, EXPIRY_MS);
      // Don't let this timer keep the process alive on its own.
      timeout.unref?.();
      pending.set(runId, { filePath, size, fileName, organizationId, timeout });
    },

    // One-shot: the first successful claim consumes the entry, so a second
    // tab or a retry after a network hiccup can't double-download (or worse,
    // double count as "succeeded" while the first request is still streaming).
    // Ownership of the file transfers to the CALLER — after streaming it to
    // the client (or failing to), the caller deletes it.
    takeReadyDownload({
      runId,
      organizationId,
    }: {
      runId: string;
      organizationId: string;
    }): { filePath: string; size: number; fileName: string } | undefined {
      const entry = pending.get(runId);
      if (!entry || entry.organizationId !== organizationId) {
        return undefined;
      }
      clearTimeout(entry.timeout);
      pending.delete(runId);
      return { filePath: entry.filePath, size: entry.size, fileName: entry.fileName };
    },

    // Used when a run is deleted/cancelled before it was ever downloaded —
    // frees the spool file instead of leaking it until the TTL fires.
    discard({ runId }: { runId: string }): void {
      const entry = pending.get(runId);
      if (entry) {
        clearTimeout(entry.timeout);
        pending.delete(runId);
        void import('node:fs/promises').then(({ unlink }) => unlink(entry.filePath).catch(() => {}));
      }
    },
  };
}

export type LocalDeliveryService = ReturnType<typeof createLocalDeliveryService>;
