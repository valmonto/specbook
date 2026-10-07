ALTER TABLE "project_environment" ADD COLUMN "extra_domains" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "extra_domains" jsonb DEFAULT '[]' NOT NULL;