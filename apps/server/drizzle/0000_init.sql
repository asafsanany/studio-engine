CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`client` text NOT NULL,
	`name` text NOT NULL,
	`rel_path` text NOT NULL,
	`rel_key` text NOT NULL,
	`state` text NOT NULL,
	`step` integer,
	`sub_progress` text,
	`failed_at` integer,
	`error` text,
	`stopped_at` integer,
	`inputs` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`footage_seconds` real DEFAULT 0 NOT NULL,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_change_at` integer NOT NULL,
	`settled_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`output` text,
	`attempt` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_rel_key_unique` ON `jobs` (`rel_key`);--> statement-breakpoint
CREATE INDEX `jobs_updated_at_idx` ON `jobs` (`updated_at`);--> statement-breakpoint
CREATE INDEX `jobs_state_settled_at_idx` ON `jobs` (`state`,`settled_at`);--> statement-breakpoint
CREATE TABLE `step_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`step` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`footage_seconds` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `step_runs_job_step_idx` ON `step_runs` (`job_id`,`step`);--> statement-breakpoint
CREATE INDEX `step_runs_step_ended_at_idx` ON `step_runs` (`step`,`ended_at`);