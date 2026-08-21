CREATE TABLE `pending_mount` (
	`operation_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`asset_path` text NOT NULL,
	`asset_content_hash` text NOT NULL,
	`upload_fingerprint` text NOT NULL,
	`at_seconds` real NOT NULL,
	`track_index` integer NOT NULL,
	`state` text DEFAULT 'uploaded_unmounted' NOT NULL,
	`last_error_code` text,
	`last_error_message` text,
	`mounted_scene_id` text,
	`mounted_revision` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_pending_mount_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_pending_mount_state" CHECK("state" IN ('uploaded_unmounted', 'mounted', 'abandoned')),
	CONSTRAINT "ck_pending_mount_position" CHECK("at_seconds" >= 0 AND "track_index" >= 0),
	CONSTRAINT "ck_pending_mount_failure_pair" CHECK(("last_error_code" IS NULL) = ("last_error_message" IS NULL)),
	CONSTRAINT "ck_pending_mount_shape" CHECK((
    ("state" = 'mounted' AND "mounted_scene_id" IS NOT NULL AND "mounted_revision" IS NOT NULL
      AND "last_error_code" IS NULL AND "last_error_message" IS NULL)
    OR ("state" = 'uploaded_unmounted' AND "mounted_scene_id" IS NULL AND "mounted_revision" IS NULL)
    OR ("state" = 'abandoned' AND "mounted_scene_id" IS NULL AND "mounted_revision" IS NULL
      AND "last_error_code" IS NOT NULL AND "last_error_message" IS NOT NULL)
  ))
);
--> statement-breakpoint
ALTER TABLE `mutation_journal` ADD `pending_transition` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mutation_journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`entity` text,
	`from_hash` text,
	`previous_content` blob,
	`previous_object_hash` text,
	`previous_byte_size` integer DEFAULT 0 NOT NULL,
	`staged_tmp_path` text,
	`staged_target_path` text,
	`staged_content_hash` text,
	`to_hash` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`actor` text NOT NULL,
	`grant_id` text,
	`backup_id` text,
	`tool_audit_json` text,
	`pending_transition` text,
	`created_at` text NOT NULL,
	`settled_at` text,
	CONSTRAINT `fk_mutation_journal_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT `fk_mutation_journal_grant_id_approval_grant_id_fk` FOREIGN KEY (`grant_id`) REFERENCES `approval_grant`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_mutation_journal_backup_id_backup_manifest_id_fk` FOREIGN KEY (`backup_id`) REFERENCES `backup_manifest`(`id`),
	CONSTRAINT "ck_journal_kind" CHECK("kind" IN ('file', 'entity', 'composite')),
	CONSTRAINT "ck_journal_status" CHECK("status" IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned', 'rolled_back')),
	CONSTRAINT "ck_journal_tool_audit_json" CHECK("tool_audit_json" IS NULL OR json_valid("tool_audit_json")),
	CONSTRAINT "ck_journal_pending_transition" CHECK("pending_transition" IS NULL OR json_valid("pending_transition")),
	CONSTRAINT "ck_journal_actor" CHECK("actor" IN ('user', 'agent', 'cli-external', 'system')),
	CONSTRAINT "ck_journal_previous_size" CHECK("previous_byte_size" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_mutation_journal`(`id`, `project_id`, `kind`, `path`, `entity`, `from_hash`, `previous_content`, `previous_object_hash`, `previous_byte_size`, `staged_tmp_path`, `staged_target_path`, `staged_content_hash`, `to_hash`, `status`, `actor`, `grant_id`, `backup_id`, `tool_audit_json`, `created_at`, `settled_at`) SELECT `id`, `project_id`, `kind`, `path`, `entity`, `from_hash`, `previous_content`, `previous_object_hash`, `previous_byte_size`, `staged_tmp_path`, `staged_target_path`, `staged_content_hash`, `to_hash`, `status`, `actor`, `grant_id`, `backup_id`, `tool_audit_json`, `created_at`, `settled_at` FROM `mutation_journal`;--> statement-breakpoint
DROP TABLE `mutation_journal`;--> statement-breakpoint
ALTER TABLE `__new_mutation_journal` RENAME TO `mutation_journal`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_journal_project` ON `mutation_journal` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_pending` ON `mutation_journal` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_grant_id` ON `mutation_journal` (`grant_id`) WHERE "mutation_journal"."grant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_journal_project_unresolved` ON `mutation_journal` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_journal_pending_open_operation` ON `mutation_journal` (json_extract("pending_transition", '$.operationId')) WHERE "mutation_journal"."pending_transition" IS NOT NULL AND json_extract("mutation_journal"."pending_transition", '$.kind') = 'open';--> statement-breakpoint
CREATE INDEX `idx_pending_mount_project_state` ON `pending_mount` (`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_pending_mount_state_updated` ON `pending_mount` (`state`,`updated_at`);