CREATE TABLE "deployment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"environment_id" uuid NOT NULL,
	"sha" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_status_check" CHECK (status IN ('queued', 'building', 'deploying', 'healthy', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "deployment_environment_id_idx" ON "deployment" ("environment_id","created_at");--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_environment_id_project_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "project_environment"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;