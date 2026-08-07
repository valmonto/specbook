ALTER TABLE "project" ADD COLUMN "auto_pause_kind" varchar(16);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "auto_pause_pointer" varchar(256);--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "ci_failure_kind" varchar(16);--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "ci_retried_sha" varchar(64);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_auto_pause_kind_check" CHECK (auto_pause_kind IS NULL OR auto_pause_kind IN ('retryable', 'setup', 'external'));--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_ci_failure_kind_check" CHECK (ci_failure_kind IS NULL OR ci_failure_kind IN ('retryable', 'setup', 'external'));