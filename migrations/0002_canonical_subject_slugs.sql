-- Settle the subject-slug drift: five short STEM-only slugs become the twelve
-- canonical long ones.
--
-- Production served `bio, chem, cs, math, physics`. db/schema.sql seeded
-- `biology, chemistry, computer-science, mathematics, physics` plus seven more,
-- so re-running it would have *added* a second, near-duplicate subject list
-- rather than reconciling. The twelve win for a reason that is not cosmetic:
-- the five are STEM-only, and a cost-sharing site for academics that cannot
-- offer humanities, social sciences, education or economics is excluding the
-- fields with the thinnest travel budgets.
--
-- Note `physics` is already correct and is deliberately not renamed; only four
-- slugs actually move.

-- 1. Upsert all twelve. ON CONFLICT ... DO UPDATE rather than INSERT OR IGNORE
--    so that names converge too: production's stored names were never in
--    version control, and IGNORE would leave whatever is there. After this
--    statement the table holds the twelve plus the four stale short slugs.
INSERT INTO tags (slug, name) VALUES
    ('mathematics', 'Mathematics'),
    ('physics', 'Physics'),
    ('chemistry', 'Chemistry'),
    ('biology', 'Biology'),
    ('computer-science', 'Computer Science'),
    ('engineering', 'Engineering'),
    ('medicine', 'Medicine & Health'),
    ('earth-science', 'Earth & Environmental Science'),
    ('social-sciences', 'Social Sciences'),
    ('economics', 'Economics & Business'),
    ('humanities', 'Humanities'),
    ('education', 'Education')
ON CONFLICT(slug) DO UPDATE SET name = excluded.name;

-- 2. Repoint the join rows before the old parents disappear. Insert-then-
--    repoint-then-delete is used rather than UPDATE-ing tags.slug in place
--    because conference_tags.tag_slug is a foreign key onto it with no
--    ON UPDATE CASCADE — this ordering never leaves a dangling reference, so
--    it is correct whether or not foreign keys are being enforced.
--
--    OR REPLACE handles the one collision this can hit: conference_tags is keyed
--    (tag_slug, conference_id), so a conference somehow tagged both `cs` and
--    `computer-science` would violate the primary key on rename. REPLACE
--    collapses the pair into one row, which is the intended meaning. Plain
--    UPDATE would abort the migration and OR IGNORE would silently drop the tag.
UPDATE OR REPLACE conference_tags SET tag_slug = 'mathematics'     WHERE tag_slug = 'math';
UPDATE OR REPLACE conference_tags SET tag_slug = 'chemistry'       WHERE tag_slug = 'chem';
UPDATE OR REPLACE conference_tags SET tag_slug = 'biology'         WHERE tag_slug = 'bio';
UPDATE OR REPLACE conference_tags SET tag_slug = 'computer-science' WHERE tag_slug = 'cs';

-- 3. Drop the superseded slugs. Nothing references them now.
DELETE FROM tags WHERE slug IN ('math', 'chem', 'bio', 'cs');
