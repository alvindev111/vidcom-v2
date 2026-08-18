PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mutation_step` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`journal_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`entity` text,
	`from_hash` text,
	`to_hash` text,
	`previous_content` blob,
	`previous_object_hash` text,
	`previous_byte_size` integer DEFAULT 0 NOT NULL,
	`rollback_path` text,
	`captured_hash` text,
	`existed_before` integer,
	`capture_state` text DEFAULT 'pending' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	CONSTRAINT `fk_mutation_step_journal_id_mutation_journal_id_fk` FOREIGN KEY (`journal_id`) REFERENCES `mutation_journal`(`id`),
	CONSTRAINT "ck_step_kind" CHECK("kind" IN ('write', 'delete', 'entity', 'mkdir', 'rmdir')),
	CONSTRAINT "ck_step_status" CHECK("status" IN ('pending', 'written', 'rolled_back')),
	CONSTRAINT "ck_step_previous_size" CHECK("previous_byte_size" >= 0),
	CONSTRAINT "ck_step_capture_state" CHECK("capture_state" IN ('pending', 'captured')),
	CONSTRAINT "ck_step_capture_shape" CHECK(("capture_state" = 'pending' OR "captured_hash" IS "from_hash")),
	CONSTRAINT "ck_step_shape" CHECK((("kind" = 'entity' AND "path" IS NULL AND "entity" IS NOT NULL AND "existed_before" IS NULL) OR ("kind" IN ('write', 'delete') AND "path" IS NOT NULL AND "entity" IS NULL AND "existed_before" IS NULL) OR ("kind" IN ('mkdir', 'rmdir') AND "path" IS NOT NULL AND "entity" IS NULL AND "from_hash" IS NULL AND "to_hash" IS NULL AND "existed_before" IS NOT NULL)))
);
--> statement-breakpoint
INSERT INTO `__new_mutation_step`(`id`, `journal_id`, `ordinal`, `kind`, `path`, `entity`, `from_hash`, `to_hash`, `previous_content`, `previous_object_hash`, `previous_byte_size`, `rollback_path`, `captured_hash`, `existed_before`, `capture_state`, `status`) SELECT `id`, `journal_id`, `ordinal`, `kind`, `path`, `entity`, `from_hash`, `to_hash`, `previous_content`, `previous_object_hash`, `previous_byte_size`, `rollback_path`, `captured_hash`, `existed_before`, `capture_state`, `status` FROM `mutation_step`;--> statement-breakpoint
DROP TABLE `mutation_step`;--> statement-breakpoint
ALTER TABLE `__new_mutation_step` RENAME TO `mutation_step`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_step_journal_ordinal` ON `mutation_step` (`journal_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_step_journal` ON `mutation_step` (`journal_id`,`ordinal`);