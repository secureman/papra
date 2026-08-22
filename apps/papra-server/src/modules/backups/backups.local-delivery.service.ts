// Local-folder destinations don't have anywhere server-side to put the
// envelope — the whole point is that it goes to the *browser's* machine (see
// drivers/local/local.driver.ts). Since runBackupPipeline is a fire-and-forget
// background job with no HTTP response left to stream the file down, we hold
// the finished envelope here in memory just long enough for the client's next
// poll to notice status === 'ready_for_download' and fetch it.
//
// This is intentionally NOT durable storage: if the server restarts, or
// nobody has the backups page open within EXPIRY_MS, the run is marked
// failed and the memory is freed. Local backups are meant to be an
// immediate, attended action (you click "Run backup", your browser saves
// the file) — not a fire-and-forget you check on the next day.

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

type PendingLocalDownload = {
  envelope: Buffer;
  fileName: string;
  organizationId: string;
  timeout: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingLocalDownload>();

export function createLocalDeliveryService() {
  return {
    // Registers an envelope for a run and returns once it either gets
    // claimed via takeReadyDownload() or expires. `onExpire` lets the caller
    // mark the run row as failed so it doesn't sit at "ready_for_download"
    // forever if nobody was there to receive it.
    holdForDownload({
      runId,
      envelope,
      fileName,
      organizationId,
      onExpire,
    }: {
      runId: string;
      envelope: Buffer;
      fileName: string;
      organizationId: string;
      onExpire: () => void;
    }): void {
      const timeout = setTimeout(() => {
        pending.delete(runId);
        onExpire();
      }, EXPIRY_MS);
      // Don't let this timer keep the process alive on its own.
      timeout.unref?.();
      pending.set(runId, { envelope, fileName, organizationId, timeout });
    },

    // One-shot: the first successful fetch consumes it, so a second tab or a
    // retry after a network hiccup can't double-download (or worse, double
    // count as "succeeded" while the first request is still streaming).
    takeReadyDownload({
      runId,
      organizationId,
    }: {
      runId: string;
      organizationId: string;
    }): { envelope: Buffer; fileName: string } | undefined {
      const entry = pending.get(runId);
      if (!entry || entry.organizationId !== organizationId) {
        return undefined;
      }
      clearTimeout(entry.timeout);
      pending.delete(runId);
      return { envelope: entry.envelope, fileName: entry.fileName };
    },

    // Used when a run is deleted/cancelled before it was ever downloaded.
    discard({ runId }: { runId: string }): void {
      const entry = pending.get(runId);
      if (entry) {
        clearTimeout(entry.timeout);
        pending.delete(runId);
      }
    },
  };
}

export type LocalDeliveryService = ReturnType<typeof createLocalDeliveryService>;
