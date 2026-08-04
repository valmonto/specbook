ALTER TABLE "server" ADD COLUMN "data_root_env_enc" text;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "provision_status" varchar(16) DEFAULT 'unprovisioned' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "provision_error" text;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "provisioned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_provision_status_check" CHECK (provision_status IN ('unprovisioned', 'provisioning', 'provisioned', 'failed'));