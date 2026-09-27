CREATE TABLE `whiteboards` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scene_json` text,
	`steps_json` text DEFAULT '[]' NOT NULL,
	`applied_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
