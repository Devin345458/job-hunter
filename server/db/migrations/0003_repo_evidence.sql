CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repo_commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`sha` text NOT NULL,
	`authored_at` text NOT NULL,
	`author_name` text,
	`author_email` text,
	`message` text NOT NULL,
	`paths_json` text,
	`url` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `repo_commits_repo_sha_idx` ON `repo_commits` (`repo`,`sha`);--> statement-breakpoint
CREATE INDEX `repo_commits_authored_at_idx` ON `repo_commits` (`authored_at`);--> statement-breakpoint
CREATE TABLE `repo_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`detail` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `repo_facts_repo_idx` ON `repo_facts` (`repo`);--> statement-breakpoint
CREATE INDEX `repo_facts_kind_name_idx` ON `repo_facts` (`kind`,`name`);--> statement-breakpoint
CREATE TABLE `repo_sources` (
	`full_name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`owner_type` text,
	`is_private` integer DEFAULT false NOT NULL,
	`is_fork` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`size_kb` integer,
	`default_branch` text,
	`html_url` text,
	`pushed_at` text,
	`token_index` integer,
	`included` integer,
	`listed_at` text,
	`head_sha` text,
	`indexed_at` text,
	`commit_count` integer,
	`skip_reason` text,
	`index_error` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `repo_sources_owner_idx` ON `repo_sources` (`owner`);--> statement-breakpoint
CREATE TABLE `repo_suggestions` (
	`question_id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`subject` text,
	`terms_json` text,
	`level` text,
	`draft` text,
	`evidence_json` text,
	`commit_shas_json` text,
	`error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
