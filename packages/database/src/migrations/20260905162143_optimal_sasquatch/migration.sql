CREATE TABLE "data_access_audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"org_id" uuid NOT NULL,
	"environment_id" uuid,
	"project_name" varchar(255) NOT NULL,
	"environment_name" varchar(32) NOT NULL,
	"api_key_id" uuid,
	"agent_name" varchar(64),
	"user_id" uuid,
	"user_name" varchar(255),
	"task_id" uuid,
	"resource" varchar(16) NOT NULL,
	"operation" varchar(32) NOT NULL,
	"target" text,
	"outcome" varchar(16) NOT NULL,
	"detail" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_access_audit_resource_check" CHECK (resource IN ('database', 'cache', 'storage', 'grant')),
	CONSTRAINT "data_access_audit_outcome_check" CHECK (outcome IN ('allowed', 'denied', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "mcp_access" varchar(8) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "mcp_access_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "mcp_access_by" uuid;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "mcp_access_reason" text;--> statement-breakpoint
CREATE INDEX "data_access_audit_environment_idx" ON "data_access_audit" ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "data_access_audit_org_idx" ON "data_access_audit" ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_mcp_access_by_user_id_fkey" FOREIGN KEY ("mcp_access_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "data_access_audit" ADD CONSTRAINT "data_access_audit_org_id_organization_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "data_access_audit" ADD CONSTRAINT "data_access_audit_environment_id_project_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "project_environment"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "data_access_audit" ADD CONSTRAINT "data_access_audit_api_key_id_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_key"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "data_access_audit" ADD CONSTRAINT "data_access_audit_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "data_access_audit" ADD CONSTRAINT "data_access_audit_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_mcp_access_check" CHECK (mcp_access IN ('none', 'read', 'write'));