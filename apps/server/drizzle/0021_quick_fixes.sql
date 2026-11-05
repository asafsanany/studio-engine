CREATE TABLE `quick_fixes` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`note_id` text NOT NULL,
	`round` integer NOT NULL,
	`status` text NOT NULL,
	`step` integer,
	`step_label` text,
	`said` text,
	`why` text,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`duration_sec` real,
	`has_compare` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quick_fixes_job_round_idx` ON `quick_fixes` (`job_id`,`round`);--> statement-breakpoint
CREATE INDEX `quick_fixes_note_idx` ON `quick_fixes` (`note_id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `review_effort` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `revise_tier` text;--> statement-breakpoint
ALTER TABLE `review_notes` ADD `route_status` text;--> statement-breakpoint
ALTER TABLE `review_notes` ADD `route_tier` text;--> statement-breakpoint
ALTER TABLE `review_notes` ADD `route_kind` text;--> statement-breakpoint
ALTER TABLE `review_notes` ADD `route_why` text;--> statement-breakpoint
ALTER TABLE `review_notes` ADD `fix_id` text;--> statement-breakpoint
ALTER TABLE `review_notes` ADD `fixed_at` integer;
--> statement-breakpoint
UPDATE `jobs` SET `review_effort` = `effort` WHERE `state` = 'review' AND `effort` IS NOT NULL;