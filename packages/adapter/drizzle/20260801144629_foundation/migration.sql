CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`project_id` text,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`revision_id` integer,
	`job_id` text,
	`protocol_version` text,
	`outcome` text NOT NULL,
	`error_code` text,
	`detail` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_audit_entry_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT `fk_audit_entry_revision_id_revision_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `revision`(`id`),
	CONSTRAINT `fk_audit_entry_job_id_job_id_fk` FOREIGN KEY (`job_id`) REFERENCES `job`(`id`),
	CONSTRAINT "ck_audit_actor" CHECK("actor" IN ('user', 'agent', 'cli-external', 'system')),
	CONSTRAINT "ck_audit_outcome" CHECK("outcome" IN ('ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE `entity_state` (
	`project_id` text NOT NULL,
	`entity` text NOT NULL,
	`revision` integer NOT NULL,
	`content_hash` text NOT NULL,
	`backing_path` text NOT NULL,
	`last_actor` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `entity_state_pk` PRIMARY KEY(`project_id`, `entity`),
	CONSTRAINT `fk_entity_state_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_entity_actor" CHECK("last_actor" IN ('user', 'agent', 'cli-external', 'system'))
);
--> statement-breakpoint
CREATE TABLE `event_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`project_id` text,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_event_outbox_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_event_type" CHECK("type" IN ('file.changed', 'project.changed', 'job.progress', 'job.done'))
);
--> statement-breakpoint
CREATE TABLE `job` (
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
	`attempt` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`input_hash` text NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`worker_id` text,
	`heartbeat_at` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT `fk_job_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_job_progress" CHECK("progress" BETWEEN 0 AND 1),
	CONSTRAINT "ck_job_attempt" CHECK("attempt" >= 0),
	CONSTRAINT "ck_job_status" CHECK("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ck_job_cancel" CHECK("cancel_requested" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `mutation_journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`entity` text,
	`from_hash` text,
	`previous_content` blob,
	`previous_byte_size` integer DEFAULT 0 NOT NULL,
	`staged_tmp_path` text,
	`staged_target_path` text,
	`staged_content_hash` text,
	`to_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	`settled_at` text,
	CONSTRAINT `fk_mutation_journal_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_journal_kind" CHECK("kind" IN ('file', 'entity')),
	CONSTRAINT "ck_journal_status" CHECK("status" IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned')),
	CONSTRAINT "ck_journal_actor" CHECK("actor" IN ('user', 'agent', 'cli-external', 'system')),
	CONSTRAINT "ck_journal_previous_size" CHECK("previous_byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `project_registry` (
	`id` text PRIMARY KEY,
	`workspace_root` text NOT NULL,
	`slug` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registry_cache` (
	`key` text PRIMARY KEY,
	`payload` text,
	`fetched_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revision` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`entity` text,
	`content_hash` text NOT NULL,
	`parent_revision` integer,
	`actor` text NOT NULL,
	`summary` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_revision_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT `fk_revision_parent_revision_revision_id_fk` FOREIGN KEY (`parent_revision`) REFERENCES `revision`(`id`),
	CONSTRAINT "ck_revision_kind" CHECK("kind" IN ('file', 'entity')),
	CONSTRAINT "ck_revision_actor" CHECK("actor" IN ('user', 'agent', 'cli-external', 'system'))
);
--> statement-breakpoint
CREATE TABLE `revision_blob` (
	`revision_id` integer PRIMARY KEY,
	`previous_content` blob,
	`byte_size` integer NOT NULL,
	CONSTRAINT `fk_revision_blob_revision_id_revision_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `revision`(`id`) ON DELETE CASCADE,
	CONSTRAINT "ck_revision_blob_size" CHECK("byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `workspace_lease` (
	`workspace_root` text PRIMARY KEY,
	`lease_id` text NOT NULL,
	`holder_id` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_project` ON `audit_entry` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_entry` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_entry` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_entity_backing` ON `entity_state` (`project_id`,`backing_path`);--> statement-breakpoint
CREATE INDEX `idx_event_type` ON `event_outbox` (`type`);--> statement-breakpoint
CREATE INDEX `idx_event_project` ON `event_outbox` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_event_created` ON `event_outbox` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_job_type` ON `job` (`type`);--> statement-breakpoint
CREATE INDEX `idx_job_claim` ON `job` (`status`,`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_job_recovery` ON `job` (`status`,`heartbeat_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_job_idempotency` ON `job` (`project_id`,`type`,`idempotency_key`) WHERE "job"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_journal_project` ON `mutation_journal` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_pending` ON `mutation_journal` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_location` ON `project_registry` (`workspace_root`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_project_last_seen` ON `project_registry` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_registry_cache_expires` ON `registry_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_revision_project_created` ON `revision` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_lease_expires` ON `workspace_lease` (`expires_at`);