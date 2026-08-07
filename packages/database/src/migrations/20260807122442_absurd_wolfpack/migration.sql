ALTER TABLE "project" ADD COLUMN "budget_usd_cents" integer;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "cost_tokens_in" bigint;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "cost_tokens_out" bigint;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "cost_usd_cents" integer;