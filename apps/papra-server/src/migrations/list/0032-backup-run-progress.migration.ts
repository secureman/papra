import type { Migration } from '../migrations.types';
import { sql } from 'drizzle-orm';

// Backups previously only ever showed a status word (pending/uploading) with
// no real progress — the client had nothing to poll. This adds the same kind
// of byte/document counters the restore-job table already has, so a run can
// report real progress through both the packaging phase (reading + taring +
// encrypting documents) and the upload phase (sending bytes to the driver).
export const backupRunProgressMigration = {
  name: 'backup-run-progress',

  up: async ({ db }) => {
    await db.run(sql`
      ALTER TABLE "backup_runs" ADD COLUMN "processed_documents_count" integer NOT NULL DEFAULT 0;
    `);
    await db.run(sql`
      ALTER TABLE "backup_runs" ADD COLUMN "processed_bytes" integer;
    `);
    await db.run(sql`
      ALTER TABLE "backup_runs" ADD COLUMN "total_raw_bytes" integer;
    `);
    await db.run(sql`
      ALTER TABLE "backup_runs" ADD COLUMN "uploaded_bytes" integer;
    `);

    // New intermediate 'packaging' status needs to count as "in progress" for
    // the single-in-progress-run guard, same as 'pending'/'uploading' already do.
    await db.run(sql`DROP INDEX IF EXISTS "backup_runs_single_in_progress_per_destination_index"`);
    await db.run(sql`
      CREATE UNIQUE INDEX "backup_runs_single_in_progress_per_destination_index"
      ON "backup_runs" ("destination_id")
      WHERE "status" IN ('pending', 'packaging', 'uploading')
    `);
  },

  down: async ({ db }) => {
    await db.run(sql`ALTER TABLE "backup_runs" DROP COLUMN "processed_documents_count"`);
    await db.run(sql`ALTER TABLE "backup_runs" DROP COLUMN "processed_bytes"`);
    await db.run(sql`ALTER TABLE "backup_runs" DROP COLUMN "total_raw_bytes"`);
    await db.run(sql`ALTER TABLE "backup_runs" DROP COLUMN "uploaded_bytes"`);

    await db.run(sql`DROP INDEX IF EXISTS "backup_runs_single_in_progress_per_destination_index"`);
    await db.run(sql`
      CREATE UNIQUE INDEX "backup_runs_single_in_progress_per_destination_index"
      ON "backup_runs" ("destination_id")
      WHERE "status" IN ('pending', 'uploading')
    `);
  },
} satisfies Migration;
