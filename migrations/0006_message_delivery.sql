-- Inquiries get a delivery status, and the table gets real column types.
--
-- Until now a `message` row was written only after Mailgun accepted the email,
-- so the row meant "this was sent". That ordering had two failure modes. A
-- Mailgun outage recorded nothing at all. Worse, a D1 error *after* a successful
-- send returned a 500 for an email that had already gone out, the user retried,
-- and the author got the same inquiry twice.
--
-- The handler now writes the row first as 'pending', sends, and then settles it
-- to 'sent' or 'failed'. A retry finds the earlier row and does not send again,
-- and a failed send leaves a visible 'failed' row instead of nothing.
--
-- A rebuild rather than ADD COLUMN, for two reasons. First, the table has no
-- primary key, and settling a row needs to name it. Second, the baseline
-- declared `STRING` and `NUMBER`, which are not SQLite types. `STRING` gets
-- NUMERIC affinity, so an inquiry consisting only of digits was stored as an
-- integer. The CASTs below turn such rows back into text. Leading zeros already
-- lost to that conversion cannot be recovered.
--
-- Nothing references `message`, so it can be dropped and renamed without
-- touching foreign keys. There is still no foreign key to `posts` here, on
-- purpose: an inquiry is the record of something sent, and it outlives the post
-- it was about (see deletePost in src/db/posts.ts).
--
-- The NOT NULLs will fail this migration, loudly, if production holds a row
-- with a missing field. The application has never written one, but check before
-- deploying with:
--   SELECT COUNT(*) FROM message WHERE post_id IS NULL OR sender_email IS NULL
--     OR recipient_email IS NULL OR content IS NULL OR timestamp IS NULL

CREATE TABLE message_new (
    id INTEGER NOT NULL PRIMARY KEY,
    post_id INTEGER NOT NULL,
    sender_email TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed'))
);

-- Every existing row was written after a successful send, so 'sent' is true of
-- all of them.
INSERT INTO message_new (post_id, sender_email, recipient_email, content, timestamp, status)
SELECT CAST(post_id AS INTEGER), CAST(sender_email AS TEXT), CAST(recipient_email AS TEXT),
       CAST(content AS TEXT), CAST(timestamp AS INTEGER), 'sent'
FROM message;

DROP TABLE message;

ALTER TABLE message_new RENAME TO message;

-- Serves both reads: the duplicate check (post, sender, recent) and the
-- "your inquiry was sent" notice (post, sender).
CREATE INDEX IF NOT EXISTS idx_message_post_sender ON message(post_id, sender_email, timestamp);
