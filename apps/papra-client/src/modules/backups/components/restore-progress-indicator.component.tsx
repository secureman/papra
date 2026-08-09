import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/modules/ui/components/popover';
import { Progress, ProgressLabel, ProgressValueLabel } from '@/modules/ui/components/progress';
import { estimateRestoreEta, useRestoreProgress } from './restore-progress.provider';

const STATUS_LABELS = {
  pending: 'Starting restore…',
  downloading: 'Downloading backup…',
  restoring: 'Restoring documents…',
  succeeded: 'Restore complete',
  failed: 'Restore failed',
} as const;

// Cog-wheel notification, spinning while a restore is running in the
// background — the point of this whole thing is that restoring a large
// backup can take a while, and the person shouldn't be stuck watching a
// blocked page (or worse, a request timeout) to know it's still happening.
export const RestoreProgressIndicator: Component = () => {
  const { activeJob, now } = useRestoreProgress();

  const eta = () => {
    const job = activeJob();
    if (!job) {
      return null;
    }
    return estimateRestoreEta({ job, now: now() });
  };

  return (
    <Show when={activeJob()}>
      {(job) => (
        <Popover>
          <PopoverTrigger
            as={Button}
            variant="outline"
            size="icon"
            class="relative"
            aria-label="Restore in progress"
          >
            <div class="i-tabler-settings size-4 animate-spin" style={{ 'animation-duration': '2.5s' }} />
            <span class="absolute -top-1 -right-1 size-2 rounded-full bg-primary" />
          </PopoverTrigger>

          <PopoverContent class="w-80">
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-2">
                <div class="i-tabler-settings size-4 animate-spin text-primary" style={{ 'animation-duration': '2.5s' }} />
                <span class="text-sm font-medium">{STATUS_LABELS[job().status]}</span>
              </div>

              <Show when={eta()?.percent !== null && eta()?.percent !== undefined}>
                <Progress value={eta()?.percent ?? 0} minValue={0} maxValue={100}>
                  <div class="flex justify-between text-xs text-muted-foreground">
                    <ProgressLabel>{eta()?.label}</ProgressLabel>
                    <ProgressValueLabel />
                  </div>
                </Progress>
              </Show>

              <Show when={eta()?.percent === null || eta()?.percent === undefined}>
                <div class="text-xs text-muted-foreground">{eta()?.label}</div>
              </Show>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </Show>
  );
};
