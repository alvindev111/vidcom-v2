ALTER TABLE `project_registry` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `workspace_operation` ADD `backup_id` text;--> statement-breakpoint
DROP INDEX `uq_project_location`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_location` ON `project_registry` (`workspace_root`,`slug`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_project_deleted` ON `project_registry` (`deleted_at`);
