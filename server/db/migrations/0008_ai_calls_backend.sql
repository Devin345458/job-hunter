ALTER TABLE `ai_calls` ADD `backend` text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `est_cost_usd` real DEFAULT 0 NOT NULL;