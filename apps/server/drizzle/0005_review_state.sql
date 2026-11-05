ALTER TABLE `jobs` ADD `run_kind` text DEFAULT 'edit' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `round` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `preview` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `approved_at` integer;--> statement-breakpoint
ALTER TABLE `step_runs` ADD `run_kind` text DEFAULT 'edit' NOT NULL;