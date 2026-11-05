-- Brief becomes step 1 (CVP-99): every stored step id moves up by one, so a job that was at
-- Transcribe (1) is now at Transcribe (2), a job that failed at Render (7) still failed at Render
-- (now 8), and the ETA history of each named step keeps its meaning. Runs once, in the same
-- transaction as the other pending migrations. Nothing is added to the schema.
UPDATE `jobs` SET `step` = `step` + 1 WHERE `step` IS NOT NULL;--> statement-breakpoint
UPDATE `jobs` SET `failed_at` = `failed_at` + 1 WHERE `failed_at` IS NOT NULL;--> statement-breakpoint
UPDATE `jobs` SET `stopped_at` = `stopped_at` + 1 WHERE `stopped_at` IS NOT NULL;--> statement-breakpoint
UPDATE `step_runs` SET `step` = `step` + 1;
