ALTER TABLE "project" DROP CONSTRAINT "project_mode_check", ADD CONSTRAINT "project_mode_check" CHECK (mode IN ('manual', 'auto_merge', 'auto', 'autonomous'));--> statement-breakpoint
ALTER TABLE "data_access_audit" DROP CONSTRAINT "data_access_audit_resource_check", ADD CONSTRAINT "data_access_audit_resource_check" CHECK (resource IN ('database', 'cache', 'storage', 'logs', 'grant'));
