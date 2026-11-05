CREATE TABLE `font_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`job_id` text NOT NULL,
	`round` integer NOT NULL,
	`at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `font_requests_open_idx` ON `font_requests` (`resolved_at`,`at`);--> statement-breakpoint
CREATE TABLE `font_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`family` text NOT NULL,
	`weight` integer NOT NULL,
	`italic` integer NOT NULL,
	`job_id` text NOT NULL,
	`round` integer NOT NULL,
	`source` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `font_uses_job_idx` ON `font_uses` (`job_id`);