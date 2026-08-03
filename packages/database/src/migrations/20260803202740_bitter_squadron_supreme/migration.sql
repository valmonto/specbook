CREATE TABLE "project_environment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"project_id" uuid NOT NULL,
	"name" varchar(32) NOT NULL,
	"server_id" uuid NOT NULL,
	"domain" varchar(255),
	"deploy_path" varchar(500),
	"auto_deploy" boolean DEFAULT false NOT NULL,
	"platform_env" jsonb DEFAULT '{}' NOT NULL,
	"user_env_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_environment_name_check" CHECK (name IN ('staging', 'production'))
);
--> statement-breakpoint
CREATE INDEX "project_environment_project_id_idx" ON "project_environment" ("project_id");--> statement-breakpoint
CREATE INDEX "project_environment_server_id_idx" ON "project_environment" ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_environment_project_name_uq" ON "project_environment" ("project_id","name");--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE RESTRICT;