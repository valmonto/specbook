ALTER TABLE "task" ADD COLUMN "pr_state" varchar(16);--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "ci_state" varchar(16);--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "pr_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_pr_state_check" CHECK (pr_state IS NULL OR pr_state IN ('open', 'merged', 'closed'));--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_ci_state_check" CHECK (ci_state IS NULL OR ci_state IN ('pending', 'passing', 'failing'));