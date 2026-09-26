CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`claude_token_enc` text,
	`disabled_at` text,
	`last_login_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
-- The pre-existing data belongs to the server owner, who becomes the admin. The empty
-- password hash is filled in from APP_PASSWORD_HASH on boot (services/users.ts).
INSERT INTO `users` (`id`, `username`, `display_name`, `password_hash`, `role`) VALUES ('owner', 'admin', 'Admin', '', 'admin');
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`used_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`used_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `user_settings` (`user_id`, `key`, `value`) SELECT 'owner', `key`, `value` FROM `settings`;
--> statement-breakpoint
DELETE FROM `settings`;
--> statement-breakpoint
DROP INDEX `concepts_key_idx`;
--> statement-breakpoint
ALTER TABLE `concepts` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `concepts_key_idx` ON `concepts` (`user_id`,`key`);
--> statement-breakpoint
DROP INDEX `flashcards_due_idx`;
--> statement-breakpoint
ALTER TABLE `flashcards` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `flashcards_due_idx` ON `flashcards` (`user_id`,`status`,`due_at`);
--> statement-breakpoint
DROP INDEX `focus_sessions_day_idx`;
--> statement-breakpoint
ALTER TABLE `focus_sessions` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `focus_sessions_day_idx` ON `focus_sessions` (`user_id`,`day`);
--> statement-breakpoint
DROP INDEX `memory_scope_idx`;
--> statement-breakpoint
ALTER TABLE `memory_items` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `memory_scope_idx` ON `memory_items` (`user_id`,`scope`,`document_id`);
--> statement-breakpoint
DROP INDEX `reviews_day_idx`;
--> statement-breakpoint
ALTER TABLE `reviews` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `reviews_day_idx` ON `reviews` (`user_id`,`day`);
--> statement-breakpoint
ALTER TABLE `annotations` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `diagrams` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `diagrams_user_idx` ON `diagrams` (`user_id`,`updated_at`);
--> statement-breakpoint
ALTER TABLE `documents` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `documents_user_idx` ON `documents` (`user_id`,`last_opened_at`);
--> statement-breakpoint
ALTER TABLE `exam_results` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `exam_results_user_idx` ON `exam_results` (`user_id`);
--> statement-breakpoint
ALTER TABLE `study_sessions` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `study_sessions_user_idx` ON `study_sessions` (`user_id`,`day`);
--> statement-breakpoint
ALTER TABLE `subjects` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `subjects_user_idx` ON `subjects` (`user_id`,`position`);
--> statement-breakpoint
ALTER TABLE `threads` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `topics` ADD `user_id` text DEFAULT 'owner' NOT NULL REFERENCES users(id) ON DELETE cascade;
