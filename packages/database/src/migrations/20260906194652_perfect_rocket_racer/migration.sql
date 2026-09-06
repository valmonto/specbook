ALTER TABLE "server" ADD COLUMN "mode" varchar(16) DEFAULT 'specbook' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "admin_user" varchar(64);--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "admin_secret_enc" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "ca_cert" text;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_mode_check" CHECK (mode IN ('specbook', 'external'));--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_external_credential_check" CHECK ((mode = 'external' AND admin_user IS NOT NULL AND admin_secret_enc IS NOT NULL) OR (mode <> 'external' AND admin_user IS NULL AND admin_secret_enc IS NULL));