CREATE TABLE `annotation_images` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`annotation_id` text NOT NULL,
	`mime` text NOT NULL,
	`data` blob NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`credit` text,
	`caption` text,
	`orphaned_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `annotation_images_annotation_idx` ON `annotation_images` (`annotation_id`);--> statement-breakpoint
CREATE TABLE `saved_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`annotation_id` text NOT NULL,
	`scene_json` text,
	`snapshot_png` text,
	`pending_thread_id` text,
	`orphaned_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_boards_annotation_idx` ON `saved_boards` (`annotation_id`);--> statement-breakpoint
ALTER TABLE `whiteboards` ADD `linked_board_id` text;