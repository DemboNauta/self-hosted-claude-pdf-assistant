CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page` integer NOT NULL,
	`type` text NOT NULL,
	`author` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`color` text NOT NULL,
	`anchor_json` text NOT NULL,
	`content` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `annotations_document_idx` ON `annotations` (`document_id`,`page`);