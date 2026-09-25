CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text,
	`title` text NOT NULL,
	`file_path` text NOT NULL,
	`file_size` integer NOT NULL,
	`page_count` integer,
	`has_ocr` integer DEFAULT false NOT NULL,
	`has_cover` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`source_url` text,
	`outline_json` text,
	`last_page` integer DEFAULT 1 NOT NULL,
	`last_scroll` real DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_opened_at` text,
	`deleted_at` text,
	`trashed_from_topic_id` text,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `documents_topic_idx` ON `documents` (`topic_id`);--> statement-breakpoint
CREATE INDEX `documents_deleted_idx` ON `documents` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`width` real NOT NULL,
	`height` real NOT NULL,
	`text` text NOT NULL,
	`text_layer_json` text NOT NULL,
	`viewed_at` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_document_page_idx` ON `pages` (`document_id`,`page_number`);--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `topics_subject_idx` ON `topics` (`subject_id`);