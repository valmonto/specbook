ALTER TABLE "project" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
WITH dupes AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY org_id, lower(name) ORDER BY created_at, id) AS rn
  FROM project
)
UPDATE project p SET name = left(p.name, 240) || '-' || d.rn
FROM dupes d WHERE p.id = d.id AND d.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "project_org_name_active_uq" ON "project" ("org_id",lower(name)) WHERE archived_at IS NULL;