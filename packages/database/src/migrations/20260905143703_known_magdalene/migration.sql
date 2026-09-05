ALTER TABLE "project_environment" ADD COLUMN "database_server_id" uuid;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "cache_server_id" uuid;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "storage_server_id" uuid;--> statement-breakpoint
ALTER TABLE "project_environment" ADD COLUMN "data_transport" varchar(16);--> statement-breakpoint
CREATE INDEX "project_environment_database_server_id_idx" ON "project_environment" ("database_server_id");--> statement-breakpoint
CREATE INDEX "project_environment_cache_server_id_idx" ON "project_environment" ("cache_server_id");--> statement-breakpoint
CREATE INDEX "project_environment_storage_server_id_idx" ON "project_environment" ("storage_server_id");--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_database_server_id_server_id_fkey" FOREIGN KEY ("database_server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_cache_server_id_server_id_fkey" FOREIGN KEY ("cache_server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_storage_server_id_server_id_fkey" FOREIGN KEY ("storage_server_id") REFERENCES "server"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_data_transport_check" CHECK (data_transport IS NULL OR data_transport IN ('private-network', 'tls'));