-- Two curated-list corrections, both label changes the site had outgrown.
--
-- A new file rather than an edit to 0002/0003, for the reason those two record:
-- an applied migration never runs again, so editing one reaches new databases
-- only and leaves production on the old text. That is exactly how the subject
-- slugs drifted.

-- 1. Mathematics also has to cover statistics conferences, which are a large
--    share of the field's travel and were reading as "not for me" against a
--    name that named only half of it. Slug unchanged: `mathematics` addresses
--    /subject/:slug and every conference_tags row, and nothing about the
--    display name requires moving it.
UPDATE tags SET name = 'Mathematics & Statistics' WHERE slug = 'mathematics';

-- 2. "Airport transfer" was too narrow for what people actually offer to split:
--    a ride to the venue is usually a taxi or a rideshare, booked on the day,
--    and the shuttle-from-the-airport reading was sending those posts to
--    "Other". The slug moves with the name, following 0002 rather than leaving
--    /search?share=airport-transfer as the address of a type called
--    Rideshare/Taxi — a slug that no longer describes its row is the drift this
--    project has already paid for once.
INSERT INTO share_types (slug, name, sort_order) VALUES ('rideshare', 'Rideshare/Taxi', 4)
ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;

-- Repoint before the old parent disappears: post_share_types.share_slug is a
-- foreign key onto share_types(slug) with no ON UPDATE CASCADE. OR REPLACE
-- collapses the one collision this can hit — a post somehow carrying both slugs
-- would violate the (share_slug, post_id) primary key on rename.
UPDATE OR REPLACE post_share_types SET share_slug = 'rideshare' WHERE share_slug = 'airport-transfer';

DELETE FROM share_types WHERE slug = 'airport-transfer';
