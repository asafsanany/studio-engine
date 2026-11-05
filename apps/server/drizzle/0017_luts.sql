CREATE TABLE `lut_uses` (
	`lut_key` text NOT NULL,
	`job_id` text NOT NULL,
	`round` integer NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`lut_key`, `job_id`, `round`)
);
--> statement-breakpoint
CREATE TABLE `luts` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer NOT NULL,
	`file` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`source_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `luts_slug_live_idx` ON `luts` (`slug`) WHERE "luts"."deleted_at" is null;