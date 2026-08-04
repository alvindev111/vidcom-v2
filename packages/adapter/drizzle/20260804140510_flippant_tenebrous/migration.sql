PRAGMA foreign_keys=OFF;--> statement-breakpoint
ALTER TABLE `revision` ADD `advances_source` integer DEFAULT 1 NOT NULL
  CHECK (`advances_source` IN (0, 1));--> statement-breakpoint
CREATE TABLE `workspace_operation` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_root` text NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`from_path` text,
	`to_path` text,
	`staging_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`created_at` text NOT NULL,
	`settled_at` text,
	CONSTRAINT "ck_workspace_operation_kind" CHECK("kind" IN ('agent_kit_files', 'project_create', 'project_rename', 'project_delete')),
	CONSTRAINT "ck_workspace_operation_status" CHECK("status" IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned')),
	CONSTRAINT "ck_workspace_operation_actor" CHECK("actor" IN ('user', 'agent', 'cli-external', 'system'))
);--> statement-breakpoint
CREATE TABLE `workspace_operation_step` (
	`operation_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`path` text NOT NULL,
	`from_hash` text,
	`to_hash` text,
	`previous_content` blob,
	`previous_object_hash` text,
	`previous_byte_size` integer DEFAULT 0 NOT NULL,
	`rollback_path` text,
	`captured_hash` text,
	`capture_state` text DEFAULT 'pending' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	CONSTRAINT `workspace_operation_step_pk` PRIMARY KEY(`operation_id`, `ordinal`),
	CONSTRAINT `fk_workspace_operation_step_operation_id_workspace_operation_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `workspace_operation`(`id`) ON DELETE CASCADE,
	CONSTRAINT "ck_workspace_operation_step_previous_size" CHECK("previous_byte_size" >= 0),
	CONSTRAINT "ck_workspace_operation_step_capture_state" CHECK("capture_state" IN ('pending', 'captured')),
	CONSTRAINT "ck_workspace_operation_step_status" CHECK("status" IN ('pending', 'written', 'rolled_back'))
);--> statement-breakpoint
CREATE TABLE `__new_job` (
	`id` text PRIMARY KEY,
	`project_id` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`input` text NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`stage` text,
	`result` text,
	`error_code` text,
	`error_message` text,
	`warnings_json` text,
	`cleanup_pending` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`input_hash` text NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`worker_id` text,
	`heartbeat_at` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT `fk_job_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_job_progress" CHECK("progress" BETWEEN 0 AND 1),
	CONSTRAINT "ck_job_attempt" CHECK("attempt" >= 0),
	CONSTRAINT "ck_job_status" CHECK("status" IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
	CONSTRAINT "ck_job_cancel" CHECK("cancel_requested" IN (0, 1)),
	CONSTRAINT "ck_job_cleanup_pending" CHECK("cleanup_pending" IN (0, 1)),
	CONSTRAINT "ck_job_warnings_json" CHECK("warnings_json" IS NULL OR json_valid("warnings_json"))
);--> statement-breakpoint
INSERT INTO `__new_job`(
	`id`, `project_id`, `type`, `status`, `input`, `progress`, `stage`, `result`,
	`error_code`, `error_message`, `attempt`, `idempotency_key`, `input_hash`,
	`cancel_requested`, `worker_id`, `heartbeat_at`, `created_at`, `started_at`, `finished_at`
) SELECT
	`id`, `project_id`, `type`, `status`, `input`, `progress`, `stage`, `result`,
	`error_code`, `error_message`, `attempt`, `idempotency_key`, `input_hash`,
	`cancel_requested`, `worker_id`, `heartbeat_at`, `created_at`, `started_at`, `finished_at`
FROM `job`;--> statement-breakpoint
DROP TABLE `job`;--> statement-breakpoint
ALTER TABLE `__new_job` RENAME TO `job`;--> statement-breakpoint
CREATE INDEX `idx_job_type` ON `job` (`type`);--> statement-breakpoint
CREATE INDEX `idx_job_claim` ON `job` (`status`,`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_job_recovery` ON `job` (`status`,`heartbeat_at`);--> statement-breakpoint
CREATE INDEX `idx_job_cleanup` ON `job` (`cleanup_pending`) WHERE `cleanup_pending` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_job_idempotency` ON `job` (`project_id`,`type`,`idempotency_key`) WHERE `idempotency_key` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_revision_source` ON `revision` (`project_id`,`advances_source`,`id` DESC);--> statement-breakpoint
CREATE INDEX `idx_revision_derived_path` ON `revision` (`project_id`,`path`,`id` DESC) WHERE `advances_source` = 0;--> statement-breakpoint
CREATE INDEX `idx_workspace_operation_pending` ON `workspace_operation` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_operation_project` ON `workspace_operation` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workspace_operation_step_path` ON `workspace_operation_step` (`operation_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_workspace_operation_step_path` ON `workspace_operation_step` (`path`,`operation_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
