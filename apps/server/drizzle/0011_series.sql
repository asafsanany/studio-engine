CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`format_job_id` text NOT NULL,
	`format_job` text NOT NULL,
	`state` text NOT NULL,
	`error` text,
	`version` integer DEFAULT 0 NOT NULL,
	`last_pass` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_client_name_unique` ON `series` (`client_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `series_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `episode` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `series_pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_series_id_idx` ON `jobs` (`series_id`);--> statement-breakpoint
ALTER TABLE `review_notes` ADD `add_to_series` integer DEFAULT false NOT NULL;