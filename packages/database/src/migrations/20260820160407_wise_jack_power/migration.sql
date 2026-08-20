CREATE TABLE "project_member" (
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"user_id" uuid,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_pkey" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "project_member_org_user_idx" ON "project_member" ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "project_member_project_idx" ON "project_member" ("project_id");--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_org_id_organization_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_granted_by_user_id_fkey" FOREIGN KEY ("granted_by") REFERENCES "user"("id") ON DELETE SET NULL;