CREATE TABLE `graphic_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`graphic_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`refs` text DEFAULT '[]' NOT NULL,
	`effort` text,
	`version` integer,
	`status` text,
	`step` integer,
	`error` text,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `graphic_messages_graphic_idx` ON `graphic_messages` (`graphic_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `graphic_messages_status_idx` ON `graphic_messages` (`status`);--> statement-breakpoint
CREATE TABLE `graphic_uses` (
	`graphic_id` text NOT NULL,
	`job_id` text NOT NULL,
	`version` integer NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`graphic_id`, `job_id`)
);
--> statement-breakpoint
CREATE TABLE `graphics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`folder` text NOT NULL,
	`kind` text,
	`length_sec` real,
	`variables` text DEFAULT '[]' NOT NULL,
	`when_text` text DEFAULT '' NOT NULL,
	`when_edited` integer DEFAULT false NOT NULL,
	`version` integer,
	`uses` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `graphics_updated_at_idx` ON `graphics` (`updated_at`);