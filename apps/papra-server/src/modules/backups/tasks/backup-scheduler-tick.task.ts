import type { GlobalDependencies } from '../../app/server.types';
import { createDocumentsRepository } from '../../documents/documents.repository';
import { createLogger } from '../../shared/logger/logger';
import { SCHEDULER_TICK_CRON, STALE_IN_PROGRESS_RUN_TIMEOUT_MS } from '../backups.constants';
import { cleanupOrphanedEnvelopeSpoolFiles } from '../backups.envelope-spool';
import { createBackupsRepository } from '../backups.repository';
import { createBackupsServices } from '../backups.services';
import { runDueScheduledBackupsUsecase } from '../backups.usecases';

const logger = createLogger({ namespace: 'backups:tasks:scheduler-tick' });

const TASK_NAME = 'backups.scheduler-tick';

export async function registerBackupSchedulerTickTask(deps: GlobalDependencies) {
  const { taskServices, config, db } = deps;

  if (!config.backups.kek || !config.backups.isSchedulerEnabled) {
    logger.info(
      'Backup scheduler disabled (BACKUPS_KEK unset or BACKUPS_IS_SCHEDULER_ENABLED=false)',
    );
    return;
  }

  taskServices.registerTask({
    taskName: TASK_NAME,
    handler: async () => {
      const services = createBackupsServices({ config });
      const repository = createBackupsRepository({ db });
      const documentsRepository = createDocumentsRepository({ db });

      const { triggeredCount } = await runDueScheduledBackupsUsecase({
        config,
        services,
        repository,
        documentsRepository,
        globalDeps: deps,
        logger,
      });

      if (triggeredCount > 0) {
        logger.info({ triggeredCount }, 'Triggered scheduled backups');
      }

      // Safety valve against temp-dir leaks: the pipeline and download routes
      // clean up their own spool files, but any unknown edge case that ever
      // strands an envelope while the server keeps running gets freed here on
      // the next tick instead of eating disk space forever. Only files idle
      // longer than the stale-run timeout are touched, so live runs are never
      // disturbed.
      const sweptSpoolFilesCount = await cleanupOrphanedEnvelopeSpoolFiles({
        maxAgeMs: STALE_IN_PROGRESS_RUN_TIMEOUT_MS,
      });
      if (sweptSpoolFilesCount > 0) {
        logger.info({ sweptSpoolFilesCount }, 'Swept orphaned backup envelope spool files');
      }
    },
  });

  await taskServices.schedulePeriodicJob({
    scheduleId: TASK_NAME,
    taskName: TASK_NAME,
    cron: SCHEDULER_TICK_CRON,
  });
}
