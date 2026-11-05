ALTER TABLE `deliveries` ADD `paid_on` text;
--> statement-breakpoint
DELETE FROM `deliveries`;