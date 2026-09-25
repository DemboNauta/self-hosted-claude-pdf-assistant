-- Full-text index over page text (F-SRC-01, search_library tool).
-- External-content FTS5 table kept in sync with `pages` by triggers.
CREATE VIRTUAL TABLE `pages_fts` USING fts5(
	`text`,
	content='pages',
	content_rowid='id',
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `pages_fts_ai` AFTER INSERT ON `pages` BEGIN
	INSERT INTO `pages_fts`(rowid, `text`) VALUES (new.id, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_ad` AFTER DELETE ON `pages` BEGIN
	INSERT INTO `pages_fts`(`pages_fts`, rowid, `text`) VALUES ('delete', old.id, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_au` AFTER UPDATE OF `text` ON `pages` BEGIN
	INSERT INTO `pages_fts`(`pages_fts`, rowid, `text`) VALUES ('delete', old.id, old.text);
	INSERT INTO `pages_fts`(rowid, `text`) VALUES (new.id, new.text);
END;
