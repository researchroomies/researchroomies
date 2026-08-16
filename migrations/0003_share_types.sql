-- Share types: what a post is offering to share.
--
-- A separate migration rather than part of the baseline because production does
-- not have these tables — the feature was written after the last deploy, so
-- this is a genuine forward step for every database rather than a snapshot.

-- Curated like `tags`, and for the same reason: the slugs address the
-- /search?share= filter and render as badges, so a user-created list would make
-- both unbounded.
--
-- `sort_order` exists because this list has a meaningful order that alphabetical
-- destroys: 'Other' has to come last, and 'Lodging' is the common case people
-- should see first. `tags` gets away with ORDER BY name because a subject list
-- has no such order.
CREATE TABLE IF NOT EXISTS share_types (
    slug TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Many-to-many on purpose: one post can offer a room *and* a seat in the car,
-- which is the whole point of this table existing rather than a column on posts.
CREATE TABLE IF NOT EXISTS post_share_types (
    share_slug TEXT NOT NULL,
    post_id INTEGER NOT NULL,
    PRIMARY KEY (share_slug, post_id),
    FOREIGN KEY (share_slug) REFERENCES share_types(slug),
    FOREIGN KEY (post_id) REFERENCES posts(id)
);

-- The composite primary key already indexes (share_slug, post_id), which serves
-- the /search?share= filter. This one serves the other direction: reading back
-- the badges for a set of posts.
CREATE INDEX IF NOT EXISTS idx_post_share_types_post_id ON post_share_types(post_id);

-- Upsert, matching 0002: renaming one of these later must be a new migration,
-- but this statement staying convergent means re-applying it can never leave a
-- half-updated list behind.
INSERT INTO share_types (slug, name, sort_order) VALUES
    ('lodging', 'Lodging', 1),
    ('carpool', 'Carpool', 2),
    ('rental-car', 'Rental car', 3),
    ('airport-transfer', 'Airport transfer', 4),
    ('other', 'Other', 5)
ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
