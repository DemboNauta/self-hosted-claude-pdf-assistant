CREATE TABLE `focus_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text,
	`day` text NOT NULL,
	`seconds` integer NOT NULL,
	`completed` integer NOT NULL,
	`method` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `focus_sessions_day_idx` ON `focus_sessions` (`day`);