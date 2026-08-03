CREATE TABLE "server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"ssh_user" varchar(64) DEFAULT 'deploy' NOT NULL,
	"roles" jsonb NOT NULL,
	"public_key" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"host_fingerprint" varchar(128),
	"status" varchar(32) DEFAULT 'unverified' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_status_check" CHECK (status IN ('unverified', 'reachable', 'unreachable', 'fingerprint_mismatch'))
);
--> statement-breakpoint
CREATE INDEX "server_org_id_idx" ON "server" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_org_name_uq" ON "server" ("org_id",lower(name));--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_org_id_organization_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;