CREATE TABLE `client_styles` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client` text NOT NULL,
	`state` text DEFAULT 'none' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`error` text,
	`source_job_id` text,
	`last_pass` text
);
