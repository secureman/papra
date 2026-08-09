import type { Migration } from '../migrations.types';
import { sql } from 'drizzle-orm';

export const backupRestoreJobDownloadProgressMigration = {
  name: 'backup-restore-job-download-progress',

  up: async ({ db }) => {
    await db.run(sql`
      ALTER TABLE "backup_restore_jobs" ADD COLUMN "downloaded_bytes" integer;
    `);
    await db.run(sql`
      ALTER TABLE "backup_restore_jobs" ADD COLUMN "total_bytes" integer;
    `);
  },

  down: async ({ db }) => {
    await db.run(sql`ALTER TABLE "backup_restore_jobs" DROP COLUMN "downloaded_bytes"`);
    await db.run(sql`ALTER TABLE "backup_restore_jobs" DROP COLUMN "total_bytes"`);
  },
} satisfies Migration;
