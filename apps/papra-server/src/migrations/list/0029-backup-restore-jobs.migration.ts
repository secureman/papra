import type { Migration } from '../migrations.types';
import { sql } from 'drizzle-orm';

export const backupRestoreJobsMigration = {
  name: 'backup-restore-jobs',

  up: async ({ db }) => {
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS "backup_restore_jobs" (
        "id" text PRIMARY KEY NOT NULL,
        "created_at" integer NOT NULL,
        "updated_at" integer NOT NULL,
        "organization_id" text NOT NULL,
        "destination_id" text,
        "run_id" text,
        "source" text NOT NULL,
        "status" text NOT NULL,
        "total_documents_count" integer,
        "processed_documents_count" integer NOT NULL DEFAULT 0,
        "restored_documents_count" integer,
        "untrashed_documents_count" integer,
        "skipped_duplicates_count" integer,
        "error_message" text,
        "started_at" integer,
        "completed_at" integer,
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE cascade ON DELETE cascade,
        FOREIGN KEY ("destination_id") REFERENCES "backup_destinations"("id") ON UPDATE cascade ON DELETE set null,
        FOREIGN KEY ("run_id") REFERENCES "backup_runs"("id") ON UPDATE cascade ON DELETE set null
      );
    `);

    await db.run(sql`
      CREATE INDEX IF NOT EXISTS "backup_restore_jobs_organization_id_index" ON "backup_restore_jobs" ("organization_id");
    `);
    await db.run(sql`
      CREATE INDEX IF NOT EXISTS "backup_restore_jobs_status_index" ON "backup_restore_jobs" ("status");
    `);
  },

  down: async ({ db }) => {
    await db.run(sql`DROP TABLE IF EXISTS "backup_restore_jobs"`);
  },
} satisfies Migration;
