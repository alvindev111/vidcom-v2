PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_event_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`project_id` text,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_event_outbox_project_id_project_registry_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project_registry`(`id`),
	CONSTRAINT "ck_event_type" CHECK("type" IN ('file.changed', 'project.changed', 'job.progress', 'job.done', 'workspace.changed', 'workspace.lease_lost', 'workspace.reattached', 'runtime.preparing', 'runtime.ready')),
	CONSTRAINT "ck_event_project_shape" CHECK(("type" IN ('workspace.changed', 'workspace.lease_lost', 'workspace.reattached', 'runtime.preparing', 'runtime.ready') AND "project_id" IS NULL) OR ("type" IN ('file.changed', 'project.changed', 'job.progress', 'job.done') AND "project_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_event_outbox`(`seq`, `type`, `project_id`, `payload`, `created_at`) SELECT `seq`, `type`, `project_id`, `payload`, `created_at` FROM `event_outbox`;--> statement-breakpoint
DROP TABLE `event_outbox`;--> statement-breakpoint
ALTER TABLE `__new_event_outbox` RENAME TO `event_outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_event_type` ON `event_outbox` (`type`);--> statement-breakpoint
CREATE INDEX `idx_event_project` ON `event_outbox` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_event_created` ON `event_outbox` (`created_at`);