ALTER TABLE "task" ADD COLUMN "assignee" uuid;--> statement-breakpoint
CREATE INDEX "task_assignee_idx" ON "task" ("assignee");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_user_id_fkey" FOREIGN KEY ("assignee") REFERENCES "user"("id") ON DELETE SET NULL;