ALTER TABLE "deployment" ADD COLUMN "phase" varchar(16);--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "log" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_phase_check" CHECK (phase IS NULL OR phase IN ('resolve', 'build', 'transfer', 'render', 'up'));