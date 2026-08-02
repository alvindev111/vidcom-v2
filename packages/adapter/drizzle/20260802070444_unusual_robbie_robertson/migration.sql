CREATE TABLE `approval_grant` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`tool` text NOT NULL,
	`target` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`plan_digest` text NOT NULL,
	`target_hashes` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`approver` text,
	`created_at` text NOT NULL,
	`issued_at` text,
	`reserved_at` text,
	`consumed_at` text,
	`invalidated_at` text,
	`invalidated_reason` text,
	`expires_at` text NOT NULL,
	CONSTRAINT `fk_approval_grant_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_grant_expected_revision" CHECK("expected_revision" >= 0),
	CONSTRAINT "ck_grant_target_hashes_json" CHECK(json_valid("target_hashes")),
	CONSTRAINT "ck_grant_status" CHECK("status" IN ('requested', 'issued', 'reserved', 'consumed', 'expired', 'revoked', 'invalidated')),
	CONSTRAINT "ck_grant_approver" CHECK("approver" IS NULL OR "approver" IN ('ui', 'cli')),
	CONSTRAINT "ck_grant_invalidated_reason" CHECK("invalidated_reason" IS NULL OR "invalidated_reason" IN ('orphaned', 'rollback_failed'))
);
--> statement-breakpoint
CREATE TABLE `backup_manifest` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`revision_id` integer UNIQUE,
	`reason` text NOT NULL,
	`entries` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`payload_pruned_at` text,
	CONSTRAINT `fk_backup_manifest_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT `fk_backup_manifest_revision_id_revision_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `revision`(`id`),
	CONSTRAINT "ck_backup_entries_json" CHECK(json_valid("entries"))
);
--> statement-breakpoint
CREATE TABLE `mcp_credential` (
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`secret_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`rotated_from` text,
	`expires_at` text,
	CONSTRAINT `fk_mcp_credential_rotated_from_mcp_credential_id_fk` FOREIGN KEY (`rotated_from`) REFERENCES `mcp_credential`(`id`),
	CONSTRAINT "ck_credential_secret_hash" CHECK(substr("secret_hash", 1, 7) = 'sha256:' AND length("secret_hash") = 71 AND substr("secret_hash", 8) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "ck_credential_status" CHECK("status" IN ('active', 'rotating', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE `mutation_step` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`journal_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`entity` text,
	`from_hash` text,
	`to_hash` text,
	`previous_content` blob,
	`previous_byte_size` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	CONSTRAINT `fk_mutation_step_journal_id_mutation_journal_id_fk` FOREIGN KEY (`journal_id`) REFERENCES `mutation_journal`(`id`),
	CONSTRAINT "ck_step_kind" CHECK("kind" IN ('write', 'delete', 'entity')),
	CONSTRAINT "ck_step_status" CHECK("status" IN ('pending', 'written', 'rolled_back')),
	CONSTRAINT "ck_step_previous_size" CHECK("previous_byte_size" >= 0),
	CONSTRAINT "ck_step_shape" CHECK((("kind" = 'entity' AND "path" IS NULL AND "entity" IS NOT NULL) OR ("kind" IN ('write', 'delete') AND "path" IS NOT NULL AND "entity" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE `revision_step` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`revision_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`entity` text,
	`from_hash` text,
	`to_hash` text,
	`previous_content` blob,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`backup_id` text,
	CONSTRAINT `fk_revision_step_revision_id_revision_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `revision`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_revision_step_backup_id_backup_manifest_id_fk` FOREIGN KEY (`backup_id`) REFERENCES `backup_manifest`(`id`),
	CONSTRAINT "ck_revision_step_kind" CHECK("kind" IN ('write', 'delete', 'entity')),
	CONSTRAINT "ck_revision_step_size" CHECK("byte_size" >= 0),
	CONSTRAINT "ck_revision_step_shape" CHECK((("kind" = 'entity' AND "path" IS NULL AND "entity" IS NOT NULL) OR ("kind" IN ('write', 'delete') AND "path" IS NOT NULL AND "entity" IS NULL)))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mutation_journal` (
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
	`to_hash` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`actor` text NOT NULL,
	`grant_id` text,
	`backup_id` text,
	`tool_audit_json` text,
	`created_at` text NOT NULL,
	`settled_at` text,
	CONSTRAINT `fk_mutation_journal_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT `fk_mutation_journal_grant_id_approval_grant_id_fk` FOREIGN KEY (`grant_id`) REFERENCES `approval_grant`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_mutation_journal_backup_id_backup_manifest_id_fk` FOREIGN KEY (`backup_id`) REFERENCES `backup_manifest`(`id`),
	CONSTRAINT "ck_journal_kind" CHECK("kind" IN ('file', 'entity', 'composite')),
	CONSTRAINT "ck_journal_status" CHECK("status" IN ('pending', 'committed', 'aborted', 'recovered', 'orphaned', 'rolled_back')),
	CONSTRAINT "ck_journal_tool_audit_json" CHECK("tool_audit_json" IS NULL OR json_valid("tool_audit_json")),
	CONSTRAINT "ck_journal_actor" CHECK("actor" IN ('user', 'agent', 'cli-external', 'system')),
	CONSTRAINT "ck_journal_previous_size" CHECK("previous_byte_size" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_mutation_journal`(`id`, `project_id`, `kind`, `path`, `entity`, `from_hash`, `previous_content`, `previous_byte_size`, `staged_tmp_path`, `staged_target_path`, `staged_content_hash`, `to_hash`, `status`, `actor`, `created_at`, `settled_at`) SELECT `id`, `project_id`, `kind`, `path`, `entity`, `from_hash`, `previous_content`, `previous_byte_size`, `staged_tmp_path`, `staged_target_path`, `staged_content_hash`, `to_hash`, `status`, `actor`, `created_at`, `settled_at` FROM `mutation_journal`;--> statement-breakpoint
DROP TABLE `mutation_journal`;--> statement-breakpoint
ALTER TABLE `__new_mutation_journal` RENAME TO `mutation_journal`;--> statement-breakpoint
INSERT INTO `mutation_step` (
	`journal_id`, `ordinal`, `kind`, `path`, `entity`, `from_hash`, `to_hash`,
	`previous_content`, `previous_byte_size`, `status`
)
SELECT
	`id`, 0, CASE WHEN `kind` = 'entity' THEN 'entity' ELSE 'write' END,
	CASE WHEN `kind` = 'entity' THEN NULL ELSE `path` END,
	CASE WHEN `kind` = 'entity' THEN `entity` ELSE NULL END,
	`from_hash`, `to_hash`, `previous_content`, `previous_byte_size`, 'pending'
FROM `mutation_journal`
WHERE `status` IN ('pending', 'orphaned');--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_revision` (
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
	CONSTRAINT "ck_revision_kind" CHECK("kind" IN ('file', 'entity', 'composite')),
	CONSTRAINT "ck_revision_actor" CHECK("actor" IN ('user', 'agent', 'cli-external', 'system'))
);
--> statement-breakpoint
INSERT INTO `__new_revision`(`id`, `project_id`, `kind`, `path`, `entity`, `content_hash`, `parent_revision`, `actor`, `summary`, `created_at`) SELECT `id`, `project_id`, `kind`, `path`, `entity`, `content_hash`, `parent_revision`, `actor`, `summary`, `created_at` FROM `revision`;--> statement-breakpoint
DROP TABLE `revision`;--> statement-breakpoint
ALTER TABLE `__new_revision` RENAME TO `revision`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_journal_project` ON `mutation_journal` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_pending` ON `mutation_journal` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_grant_id` ON `mutation_journal` (`grant_id`) WHERE "mutation_journal"."grant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_journal_project_unresolved` ON `mutation_journal` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_revision_project_created` ON `revision` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_grant_project` ON `approval_grant` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_grant_status` ON `approval_grant` (`status`);--> statement-breakpoint
CREATE INDEX `idx_grant_expires` ON `approval_grant` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_backup_project` ON `backup_manifest` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_backup_created` ON `backup_manifest` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_credential_secret_hash` ON `mcp_credential` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `idx_credential_status` ON `mcp_credential` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_step_journal_ordinal` ON `mutation_step` (`journal_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_step_journal` ON `mutation_step` (`journal_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_revision_step_ordinal` ON `revision_step` (`revision_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_revision_step` ON `revision_step` (`revision_id`,`ordinal`);
