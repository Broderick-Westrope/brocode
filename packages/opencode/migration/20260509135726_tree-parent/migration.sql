ALTER TABLE `message` ADD `tree_parent_id` text;--> statement-breakpoint
ALTER TABLE `session` ADD `leaf_id` text;--> statement-breakpoint
CREATE INDEX `message_session_tree_parent_idx` ON `message` (`session_id`,`tree_parent_id`);
