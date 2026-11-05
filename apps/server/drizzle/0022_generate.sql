CREATE TABLE `job_generate` (
	`job_id` text PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`voice_done` integer DEFAULT 0 NOT NULL,
	`voice_total` integer DEFAULT 0 NOT NULL,
	`looks_done` integer DEFAULT 0 NOT NULL,
	`looks_total` integer DEFAULT 0 NOT NULL,
	`keyframes_done` integer DEFAULT 0 NOT NULL,
	`keyframes_total` integer DEFAULT 0 NOT NULL,
	`clips_done` integer DEFAULT 0 NOT NULL,
	`clips_total` integer DEFAULT 0 NOT NULL,
	`below_bar` integer DEFAULT 0 NOT NULL,
	`spend_usd` real DEFAULT 0 NOT NULL,
	`budget_usd` real NOT NULL,
	`elevenlabs_chars` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
