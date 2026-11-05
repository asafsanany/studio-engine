CREATE TABLE `review_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`round` integer,
	`at_sec` real NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`audio_file` text,
	`audio_sec` real,
	`transcript_status` text,
	`add_to_style` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `review_notes_job_round_idx` ON `review_notes` (`job_id`,`round`);