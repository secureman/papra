import type { Migration } from '../migrations.types';
import { sql } from 'drizzle-orm';

export const backupRunsSingleInProgressMigration = {
  name: 'backup-runs-single-in-progress',

  up: async ({ db }) => {
    // Clear any pre-existing stuck runs so the unique index below can never
    // fail to build (e.g. duplicates left behind by the old check-then-insert).
    await db.run(sql`
      UPDATE "backup_runs"
      SET "status" = 'failed',
          "error_message" = 'Marked as failed while enabling the single in-progress run guard.',
          "completed_at" = strftime('%s', 'now') * 1000
      WHERE "status" IN ('pending', 'uploading')
        AND "created_at" <= strftime('%s', 'now') * 1000 - 86400000
    `);

    await db.run(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "backup_runs_single_in_progress_per_destination_index"
      ON "backup_runs" ("destination_id")
      WHERE "status" IN ('pending', 'uploading')
    `);
  },

  down: async ({ db }) => {
    await db.run(
      sql`DROP INDEX IF EXISTS "backup_runs_single_in_progress_per_destination_index"`,
    );
  },
} satisfies Migration;