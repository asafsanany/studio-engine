CREATE TABLE `deliveries` (
	`job_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client` text NOT NULL,
	`name` text NOT NULL,
	`rel_path` text NOT NULL,
	`delivered_at` integer NOT NULL,
	`price` real NOT NULL,
	`currency` text DEFAULT 'ILS' NOT NULL,
	`review_sec` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deliveries_delivered_at_idx` ON `deliveries` (`delivered_at`);