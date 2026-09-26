CREATE TABLE `flashcards` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text,
	`page` integer,
	`concept_id` text,
	`front` text NOT NULL,
	`back` text NOT NULL,
	`author` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`fsrs_json` text NOT NULL,
	`due_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `flashcards_due_idx` ON `flashcards` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`flashcard_id` text NOT NULL,
	`rating` integer NOT NULL,
	`reviewed_at` text NOT NULL,
	`day` text NOT NULL,
	FOREIGN KEY (`flashcard_id`) REFERENCES `flashcards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reviews_day_idx` ON `reviews` (`day`);