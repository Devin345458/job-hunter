CREATE TABLE `task_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task` text NOT NULL,
	`payload_json` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`run_after` text DEFAULT (datetime('now')) NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`pipeline_run_id` integer,
	`parent_id` integer,
	`last_error` text,
	`note` text,
	`progress_json` text,
	`result_json` text
);
--> statement-breakpoint
CREATE INDEX `task_queue_status_run_after_idx` ON `task_queue` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `task_queue_parent_idx` ON `task_queue` (`parent_id`);