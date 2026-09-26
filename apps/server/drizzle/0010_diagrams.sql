CREATE TABLE `diagrams` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`from_page` integer,
	`to_page` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `diagrams_document_idx` ON `diagrams` (`document_id`,`created_at`);