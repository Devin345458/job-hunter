CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`tailored_resume_json` text,
	`tailored_resume_pdf_path` text,
	`cover_letter` text,
	`tailoring_notes` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`submitted_at` text,
	`response_at` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `applications_job_id_idx` ON `applications` (`job_id`);--> statement-breakpoint
CREATE INDEX `applications_status_idx` ON `applications` (`status`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`company_url` text,
	`location` text,
	`remote_type` text,
	`salary_min` real,
	`salary_max` real,
	`salary_currency` text,
	`description` text,
	`url` text,
	`tags` text,
	`match_score` integer,
	`match_reasoning` text,
	`status` text DEFAULT 'new' NOT NULL,
	`found_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_source_source_id_idx` ON `jobs` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_match_score_idx` ON `jobs` (`match_score`);--> statement-breakpoint
CREATE INDEX `jobs_company_idx` ON `jobs` (`company`);--> statement-breakpoint
CREATE TABLE `knowledge_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`source` text DEFAULT 'user_answer' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_entries_category_idx` ON `knowledge_entries` (`category`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question` text NOT NULL,
	`context` text,
	`category` text,
	`application_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`asked_at` text DEFAULT (datetime('now')) NOT NULL,
	`answered_at` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `questions_status_idx` ON `questions` (`status`);--> statement-breakpoint
CREATE TABLE `search_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`keywords` text NOT NULL,
	`excluded_keywords` text,
	`locations` text,
	`remote_only` integer DEFAULT false,
	`salary_min` real,
	`salary_currency` text DEFAULT 'USD',
	`job_sources` text,
	`is_active` integer DEFAULT true,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
