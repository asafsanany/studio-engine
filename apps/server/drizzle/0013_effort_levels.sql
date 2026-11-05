-- Low and Max are no longer offered as a job's effort, and Default is Extra high. A job that had Low
-- goes to Medium and one that had Max to Extra high, the nearest levels that are left.
UPDATE `jobs` SET `effort` = 'medium' WHERE `effort` = 'low';
--> statement-breakpoint
UPDATE `jobs` SET `effort` = 'xhigh' WHERE `effort` = 'max';
