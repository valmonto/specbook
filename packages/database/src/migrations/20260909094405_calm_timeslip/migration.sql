CREATE TABLE "server_shell_session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"org_id" uuid NOT NULL,
	"server_id" uuid,
	"server_name" varchar(255) NOT NULL,
	"server_host" varchar(255) NOT NULL,
	"user_id" uuid,
	"user_name" varchar(255) NOT NULL,
	"user_email" varchar(255) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"detail" text,
	"transcript" text,
	"bytes_in" integer DEFAULT 0 NOT NULL,
	"bytes_out" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "server_shell_session_outcome_check" CHECK (outcome IN ('open', 'closed', 'expired', 'idle', 'error', 'refused'))
);
--> statement-breakpoint
CREATE INDEX "server_shell_session_org_idx" ON "server_shell_session" ("org_id","opened_at");--> statement-breakpoint
CREATE INDEX "server_shell_session_server_idx" ON "server_shell_session" ("server_id","opened_at");--> statement-breakpoint
ALTER TABLE "server_shell_session" ADD CONSTRAINT "server_shell_session_org_id_organization_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "server_shell_session" ADD CONSTRAINT "server_shell_session_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "server_shell_session" ADD CONSTRAINT "server_shell_session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;