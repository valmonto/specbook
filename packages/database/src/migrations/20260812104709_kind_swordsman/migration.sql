ALTER TABLE "task" ADD COLUMN "area" varchar(120);--> statement-breakpoint
CREATE INDEX "task_project_area_idx" ON "task" ("project_id","area");