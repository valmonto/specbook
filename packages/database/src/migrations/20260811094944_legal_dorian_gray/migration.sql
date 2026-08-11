CREATE TABLE "research" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"title" varchar(500) NOT NULL,
	"status" varchar(32) DEFAULT 'researching' NOT NULL,
	"body_markdown" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_status_check" CHECK (status IN ('researching', 'needs_review', 'accepted'))
);
--> statement-breakpoint
CREATE TABLE "research_message" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"research_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_type" varchar(16) DEFAULT 'user' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_message_author_type_check" CHECK (author_type IN ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "source_research_id" uuid;--> statement-breakpoint
CREATE INDEX "research_project_id_idx" ON "research" ("project_id");--> statement-breakpoint
CREATE INDEX "research_org_updated_idx" ON "research" ("org_id","updated_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "research_message_research_id_idx" ON "research_message" ("research_id","id");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_source_research_id_research_id_fkey" FOREIGN KEY ("source_research_id") REFERENCES "research"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "research" ADD CONSTRAINT "research_org_id_organization_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research" ADD CONSTRAINT "research_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "research" ADD CONSTRAINT "research_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "research_message" ADD CONSTRAINT "research_message_research_id_research_id_fkey" FOREIGN KEY ("research_id") REFERENCES "research"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research_message" ADD CONSTRAINT "research_message_org_id_organization_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research_message" ADD CONSTRAINT "research_message_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE CASCADE;