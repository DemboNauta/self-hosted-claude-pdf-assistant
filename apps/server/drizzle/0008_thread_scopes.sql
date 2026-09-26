ALTER TABLE `threads` ADD `topic_id` text REFERENCES topics(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `threads` ADD `subject_id` text REFERENCES subjects(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `threads_topic_idx` ON `threads` (`topic_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `threads_subject_idx` ON `threads` (`subject_id`,`updated_at`);