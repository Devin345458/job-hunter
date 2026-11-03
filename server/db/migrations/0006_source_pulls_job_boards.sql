CREATE TABLE `job_boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ats` text NOT NULL,
	`token` text NOT NULL,
	`company` text NOT NULL,
	`found_via` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_boards_ats_token_idx` ON `job_boards` (`ats`,`token`);--> statement-breakpoint
CREATE INDEX `job_boards_status_idx` ON `job_boards` (`status`);--> statement-breakpoint
CREATE TABLE `source_pulls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`config_id` integer NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`filter_hash` text,
	`last_pulled_at` text,
	`last_attempt_at` text,
	`last_status` text,
	`last_error` text,
	`last_mode` text,
	`found` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`known` integer DEFAULT 0 NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_pulls_key_idx` ON `source_pulls` (`source`,`config_id`,`scope`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `posted_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `duplicate_of` integer;--> statement-breakpoint
CREATE INDEX `jobs_duplicate_of_idx` ON `jobs` (`duplicate_of`);