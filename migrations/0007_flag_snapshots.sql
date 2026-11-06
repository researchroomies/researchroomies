-- Reports outlive the post they are about, and record whether the admin was told.
--
-- Until now `flags.post_id` was a foreign key to `posts(id)`. D1 enforces
-- foreign keys, so a post could only be deleted once its flags were gone, and
-- the post delete (then named deletePostAndFlags) removed them. The effect was
-- that an author who had been reported could erase every report against them by
-- deleting the post. For
-- moderation that is the wrong way round: deletion is exactly when the report
-- needs to survive.
--
-- So the foreign key goes, and each report carries a copy of what was reported,
-- taken when the report is made. Once the post is deleted, that copy is the only
-- record of what the reader objected to. `post_id` stays, so a report on a post
-- that still exists still links to it.
--
-- SQLite cannot drop a foreign key in place, hence the rebuild. Nothing
-- references `flags`, so it can be dropped and renamed freely.
--
-- `notified_at` is when the admin email went out. It is NULL when the send
-- failed, which until now was only a log line, and the email is still the only
-- way a report reaches anyone. A NULL here is the list a future retry or admin
-- page needs.

CREATE TABLE flags_new (
    id INTEGER NOT NULL PRIMARY KEY,
    post_id INTEGER NOT NULL,
    reason TEXT,
    flagged_by TEXT,
    timestamp INTEGER,
    post_title TEXT,
    post_description TEXT,
    post_user_id INTEGER,
    notified_at INTEGER
);

-- Every existing flag still has its post, because the old foreign key made
-- anything else impossible, so the join fills the copy in for all of them. It is
-- a LEFT JOIN anyway, so a row is never dropped by this migration.
--
-- notified_at is set to the report time for existing rows. Whether each email
-- actually went out was never recorded. Treating them as delivered is what
-- stops a future retry from re-sending every report the site has ever had.
INSERT INTO flags_new (id, post_id, reason, flagged_by, timestamp, post_title, post_description, post_user_id, notified_at)
SELECT flags.id, flags.post_id, flags.reason, flags.flagged_by, flags.timestamp,
       posts.title, posts.description, posts.user_id, flags.timestamp
FROM flags
LEFT JOIN posts ON posts.id = flags.post_id;

DROP TABLE flags;

ALTER TABLE flags_new RENAME TO flags;

-- (post_id, flagged_by) serves the "already reported" check, and its prefix
-- serves every lookup by post that idx_flags_post_id used to. A plain index,
-- not UNIQUE: production may already hold duplicate reports, and making it
-- unique would mean deleting some of them.
CREATE INDEX IF NOT EXISTS idx_flags_post_reporter ON flags(post_id, flagged_by);
