ALTER TABLE "project" ADD COLUMN "mode" varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "max_parallel" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "auto_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_mode_check" CHECK (mode IN ('manual', 'auto_merge', 'auto'));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_max_parallel_check" CHECK (max_parallel IS NULL OR (max_parallel BETWEEN 1 AND 10));