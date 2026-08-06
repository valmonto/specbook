CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"org_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"api_key_id" uuid NOT NULL,
	"server_id" uuid,
	"kind" varchar(16) DEFAULT 'external' NOT NULL,
	"status" varchar(16) DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"current_task_id" uuid,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_kind_check" CHECK (kind IN ('external', 'managed')),
	CONSTRAINT "agent_status_check" CHECK (status IN ('offline', 'idle', 'working', 'stopped', 'starting', 'auth_needed', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_api_key_id_uq" ON "agent" ("api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_org_name_uq" ON "agent" ("org_id","name");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_org_id_organization_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_api_key_id_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_key"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_current_task_id_task_id_fkey" FOREIGN KEY ("current_task_id") REFERENCES "task"("id") ON DELETE SET NULL;