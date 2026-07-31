CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"context" text,
	"repo_url" varchar(500),
	"default_branch" varchar(255) DEFAULT 'main' NOT NULL,
	"workdir" varchar(500),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"project_id" uuid NOT NULL,
	"title" varchar(500) NOT NULL,
	"context" text,
	"out_of_scope" text,
	"acceptance_criteria" jsonb DEFAULT '[]' NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"branch" varchar(255),
	"pr_url" varchar(500),
	"status_changed_by" uuid,
	"status_changed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_status_check" CHECK (status IN ('draft', 'ready', 'in_progress', 'blocked', 'needs_review', 'changes_requested', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "task_dependency" (
	"task_id" uuid,
	"depends_on_task_id" uuid,
	CONSTRAINT "task_dependency_pkey" PRIMARY KEY("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependency_no_self_check" CHECK (task_id <> depends_on_task_id)
);
--> statement-breakpoint
CREATE TABLE "task_comment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"task_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_type" varchar(16) DEFAULT 'user' NOT NULL,
	"kind" varchar(16) DEFAULT 'comment' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_comment_kind_check" CHECK (kind IN ('comment', 'progress', 'question', 'answer')),
	CONSTRAINT "task_comment_author_type_check" CHECK (author_type IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX "project_org_id_idx" ON "project" ("org_id");--> statement-breakpoint
CREATE INDEX "task_project_id_idx" ON "task" ("project_id");--> statement-breakpoint
CREATE INDEX "task_project_status_idx" ON "task" ("project_id","status","priority");--> statement-breakpoint
CREATE INDEX "task_dependency_depends_on_idx" ON "task_dependency" ("depends_on_task_id");--> statement-breakpoint
CREATE INDEX "task_comment_task_id_idx" ON "task_comment" ("task_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_org_id_organization_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_claimed_by_user_id_fkey" FOREIGN KEY ("claimed_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_status_changed_by_user_id_fkey" FOREIGN KEY ("status_changed_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_depends_on_task_id_task_id_fkey" FOREIGN KEY ("depends_on_task_id") REFERENCES "task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE CASCADE;