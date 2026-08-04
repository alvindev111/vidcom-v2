PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_approval_grant` (
	`id` text PRIMARY KEY,
	`project_id` text,
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
	CONSTRAINT "ck_grant_owner" CHECK(("project_id" IS NULL AND "target" LIKE 'location:%') OR ("project_id" IS NOT NULL AND "target" NOT LIKE 'location:%')),
	CONSTRAINT "ck_grant_status" CHECK("status" IN ('requested', 'issued', 'reserved', 'consumed', 'expired', 'revoked', 'invalidated')),
	CONSTRAINT "ck_grant_approver" CHECK("approver" IS NULL OR "approver" IN ('ui', 'cli')),
	CONSTRAINT "ck_grant_invalidated_reason" CHECK("invalidated_reason" IS NULL OR "invalidated_reason" IN ('orphaned', 'rollback_failed'))
);
--> statement-breakpoint
INSERT INTO `__new_approval_grant`(`id`, `project_id`, `tool`, `target`, `expected_revision`, `plan_digest`, `target_hashes`, `summary`, `status`, `approver`, `created_at`, `issued_at`, `reserved_at`, `consumed_at`, `invalidated_at`, `invalidated_reason`, `expires_at`) SELECT `id`, `project_id`, `tool`, `target`, `expected_revision`, `plan_digest`, `target_hashes`, `summary`, `status`, `approver`, `created_at`, `issued_at`, `reserved_at`, `consumed_at`, `invalidated_at`, `invalidated_reason`, `expires_at` FROM `approval_grant`;--> statement-breakpoint
DROP TABLE `approval_grant`;--> statement-breakpoint
ALTER TABLE `__new_approval_grant` RENAME TO `approval_grant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_grant_project` ON `approval_grant` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_grant_status` ON `approval_grant` (`status`);--> statement-breakpoint
CREATE INDEX `idx_grant_expires` ON `approval_grant` (`expires_at`);