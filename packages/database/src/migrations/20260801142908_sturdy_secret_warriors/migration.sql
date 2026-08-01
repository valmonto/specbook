ALTER TABLE "organization" ADD COLUMN "github_installation_id" bigint;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "github_account_login" varchar(255);--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "github_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "github_repo_id" bigint;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "github_repo_full_name" varchar(255);