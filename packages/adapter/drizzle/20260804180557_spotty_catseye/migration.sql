PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace_operation` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_root` text NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`from_path` text,
	`to_path` text,
	`staging_path` text,
	`backup_id` text,
	`grant_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`tool_audit_json` text,
	`created_at` text NOT NULL,
	`settled_at` text,
	CONSTRAINT `fk_workspace_operation_grant_id_approval_grant_id_fk` FOREIGN KEY (`grant_id`) REFERENCES `approval_grant`(`id`),
	CONSTRAINT "ck_workspace_operation_kind" CHECK("kind" IN ('agent_kit_files', 'project_create', 'project_rename', 'project_delete')),
	CONSTRAINT "ck_workspace_operation_status" CHECK("status" IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned')),
	CONSTRAINT "ck_workspace_operation_actor" CHECK("actor" IN ('user', 'agent', 'cli-external', 'system')),
	CONSTRAINT "ck_workspace_operation_tool_audit_json" CHECK("tool_audit_json" IS NULL OR json_valid("tool_audit_json"))
);
--> statement-breakpoint
INSERT INTO `__new_workspace_operation`(`id`, `workspace_root`, `kind`, `project_id`, `from_path`, `to_path`, `staging_path`, `backup_id`, `grant_id`, `status`, `actor`, `action`, `created_at`, `settled_at`) SELECT `id`, `workspace_root`, `kind`, `project_id`, `from_path`, `to_path`, `staging_path`, `backup_id`, `grant_id`, `status`, `actor`, `action`, `created_at`, `settled_at` FROM `workspace_operation`;--> statement-breakpoint
DROP TABLE `workspace_operation`;--> statement-breakpoint
ALTER TABLE `__new_workspace_operation` RENAME TO `workspace_operation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_workspace_operation_pending` ON `workspace_operation` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_operation_project` ON `workspace_operation` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspace_operation_grant` ON `workspace_operation` (`grant_id`) WHERE "workspace_operation"."grant_id" IS NOT NULL;
