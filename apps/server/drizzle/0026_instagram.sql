CREATE TABLE `instagram_accounts` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client` text NOT NULL,
	`handle` text NOT NULL,
	`instagram_id` text,
	`since` text,
	`added_at` integer NOT NULL,
	`full_name` text,
	`biography` text,
	`private` integer DEFAULT false NOT NULL,
	`photo_saved_at` integer
);
--> statement-breakpoint
CREATE TABLE `instagram_reel_reads` (
	`shortcode` text NOT NULL,
	`scan_id` integer NOT NULL,
	`plays` integer NOT NULL,
	`likes` integer NOT NULL,
	`comments` integer NOT NULL,
	`shares` integer,
	PRIMARY KEY(`shortcode`, `scan_id`)
);
--> statement-breakpoint
CREATE INDEX `instagram_reel_reads_scan_idx` ON `instagram_reel_reads` (`scan_id`);--> statement-breakpoint
CREATE TABLE `instagram_reels` (
	`shortcode` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`url` text NOT NULL,
	`posted_at` integer NOT NULL,
	`caption` text,
	`duration_sec` real,
	`plays` integer DEFAULT 0 NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`comments` integer DEFAULT 0 NOT NULL,
	`shares` integer,
	`sound` text,
	`coauthors` text DEFAULT '[]' NOT NULL,
	`hashtags` text DEFAULT '[]' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`paid_partnership` integer DEFAULT false NOT NULL,
	`first_scan_id` integer NOT NULL,
	`last_scan_id` integer NOT NULL,
	`job_id` text,
	`linked_at` integer
);
--> statement-breakpoint
CREATE INDEX `instagram_reels_client_posted_idx` ON `instagram_reels` (`client_id`,`posted_at`);--> statement-breakpoint
CREATE INDEX `instagram_reels_posted_at_idx` ON `instagram_reels` (`posted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `instagram_reels_job_id_unique` ON `instagram_reels` (`job_id`);--> statement-breakpoint
CREATE TABLE `instagram_scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`handle` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	`error` text,
	`followers` integer,
	`following` integer,
	`posts` integer,
	`reels_read` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`apify_run_ids` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `instagram_scans_client_started_idx` ON `instagram_scans` (`client_id`,`started_at`);