ALTER TABLE `backup_manifest` ADD `workspace_root` text;--> statement-breakpoint
ALTER TABLE `backup_manifest` ADD `slug` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_backup_manifest` (
	`id` text PRIMARY KEY,
	`project_id` text,
	`workspace_root` text,
	`slug` text,
	`revision_id` integer UNIQUE,
	`reason` text NOT NULL,
	`entries` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`payload_pruned_at` text,
	CONSTRAINT `fk_backup_manifest_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT `fk_backup_manifest_revision_id_revision_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `revision`(`id`),
	CONSTRAINT "ck_backup_entries_json" CHECK(json_valid("entries")),
	CONSTRAINT "ck_backup_owner" CHECK(("project_id" IS NOT NULL AND "workspace_root" IS NULL AND "slug" IS NULL) OR ("project_id" IS NULL AND "workspace_root" IS NOT NULL AND "slug" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_backup_manifest`(`id`, `project_id`, `revision_id`, `reason`, `entries`, `manifest_hash`, `created_at`, `payload_pruned_at`) SELECT `id`, `project_id`, `revision_id`, `reason`, `entries`, `manifest_hash`, `created_at`, `payload_pruned_at` FROM `backup_manifest`;--> statement-breakpoint
DROP TABLE `backup_manifest`;--> statement-breakpoint
ALTER TABLE `__new_backup_manifest` RENAME TO `backup_manifest`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_event_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`project_id` text,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_event_outbox_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_event_type" CHECK("type" IN ('file.changed', 'project.changed', 'job.progress', 'job.done', 'workspace.changed')),
	CONSTRAINT "ck_event_project_shape" CHECK(("type" = 'workspace.changed' AND "project_id" IS NULL) OR ("type" != 'workspace.changed' AND "project_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_event_outbox`(`seq`, `type`, `project_id`, `payload`, `created_at`) SELECT `seq`, `type`, `project_id`, `payload`, `created_at` FROM `event_outbox`;--> statement-breakpoint
DROP TABLE `event_outbox`;--> statement-breakpoint
ALTER TABLE `__new_event_outbox` RENAME TO `event_outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_backup_project` ON `backup_manifest` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_backup_location` ON `backup_manifest` (`workspace_root`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_backup_created` ON `backup_manifest` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_event_type` ON `event_outbox` (`type`);--> statement-breakpoint
CREATE INDEX `idx_event_project` ON `event_outbox` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_event_created` ON `event_outbox` (`created_at`);
