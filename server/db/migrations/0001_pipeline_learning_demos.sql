CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`ref_type` text,
	`ref_id` integer,
	`error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_calls_created_at_idx` ON `ai_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`decision` text NOT NULL,
	`reason_code` text,
	`reason_text` text,
	`features_json` text,
	`is_sandbox` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `decisions_job_id_idx` ON `decisions` (`job_id`);--> statement-breakpoint
CREATE INDEX `decisions_reason_code_idx` ON `decisions` (`reason_code`);--> statement-breakpoint
CREATE INDEX `decisions_created_at_idx` ON `decisions` (`created_at`);--> statement-breakpoint
CREATE TABLE `demo_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`gap_addressed` text,
	`tech_stack_json` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`local_path` text,
	`repo_name` text,
	`repo_url` text,
	`live_url` text,
	`files_json` text,
	`readme` text,
	`test_command` text,
	`test_output` text,
	`tests_passed` integer,
	`build_log` text,
	`cost_usd` real,
	`error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`built_at` text,
	`published_at` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `demo_projects_application_id_idx` ON `demo_projects` (`application_id`);--> statement-breakpoint
CREATE INDEX `demo_projects_status_idx` ON `demo_projects` (`status`);--> statement-breakpoint
CREATE TABLE `learned_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`pattern` text NOT NULL,
	`effect` text NOT NULL,
	`weight` integer DEFAULT 0 NOT NULL,
	`evidence_count` integer DEFAULT 0 NOT NULL,
	`reason_code` text,
	`explanation` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `learned_rules_kind_pattern_idx` ON `learned_rules` (`kind`,`pattern`,`effect`);--> statement-breakpoint
CREATE INDEX `learned_rules_active_idx` ON `learned_rules` (`active`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task` text NOT NULL,
	`trigger` text DEFAULT 'schedule' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`finished_at` text,
	`stats_json` text,
	`error` text,
	`host` text
);
--> statement-breakpoint
CREATE INDEX `pipeline_runs_task_idx` ON `pipeline_runs` (`task`);--> statement-breakpoint
CREATE INDEX `pipeline_runs_started_at_idx` ON `pipeline_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `sandbox_submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`payload_json` text NOT NULL,
	`files_json` text,
	`user_agent` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `score_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`score` integer NOT NULL,
	`skills_score` integer,
	`comp_score` integer,
	`learned_adjustment` integer,
	`breakdown_json` text,
	`reason` text DEFAULT 'initial' NOT NULL,
	`computed_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `score_history_job_id_idx` ON `score_history` (`job_id`);--> statement-breakpoint
CREATE INDEX `score_history_computed_at_idx` ON `score_history` (`computed_at`);--> statement-breakpoint
ALTER TABLE `applications` ADD `status_detail` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `is_sandbox` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` ADD `form_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `answers_json` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `form_screenshot_path` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `form_filled_at` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `form_error` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `gap_analysis_json` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `proposed_at` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `decided_at` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `submission_json` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `submit_error` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `submit_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `apply_url` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `ats_type` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `ats_meta` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `posting_text` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `enriched_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `enrich_error` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `comp_json` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `total_comp_estimate` real;--> statement-breakpoint
ALTER TABLE `jobs` ADD `requirements_json` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `skills_score` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `comp_score` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `learned_adjustment` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `score_breakdown` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `scored_at` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `is_sandbox` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_ats_type_idx` ON `jobs` (`ats_type`);--> statement-breakpoint
CREATE INDEX `jobs_found_at_idx` ON `jobs` (`found_at`);--> statement-breakpoint
ALTER TABLE `questions` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `knowledge_key` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `job_id` integer REFERENCES jobs(id);--> statement-breakpoint
ALTER TABLE `questions` ADD `blocking` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `answer_type` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `choices_json` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `dedupe_key` text;--> statement-breakpoint
CREATE INDEX `questions_dedupe_key_idx` ON `questions` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `questions_application_id_idx` ON `questions` (`application_id`);