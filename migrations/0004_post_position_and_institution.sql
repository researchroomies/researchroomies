-- Who is posting: their academic position and their institution.
--
-- Both are stated on the post rather than on the person. `users` holds an email
-- and nothing else, there is no profile page to edit, and the only writer to
-- that table is the login upsert — so a column there would have no UI and no
-- way to be corrected. A post is also the honest scope: a position is true as
-- of the trip being arranged, and the author who was a graduate student for the
-- 2026 conference is a postdoc for the 2027 one.

-- Curated like `share_types`, and the same shape for the same reasons: the
-- slugs are what a post stores, the names are what every surface renders, and
-- `sort_order` exists because this list has a real order that alphabetical
-- destroys — it runs from earliest career stage to latest, with 'Other' last.
-- Alphabetical would open on 'Graduate Student' and bury 'Other' in the middle.
CREATE TABLE IF NOT EXISTS positions (
    slug TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Upsert rather than INSERT OR IGNORE, matching 0002 and 0003: re-applying can
-- never leave a half-renamed list behind. Renaming one of these later is still
-- a new migration, never an edit to this file.
INSERT INTO positions (slug, name, sort_order) VALUES
    ('undergraduate', 'Undergraduate Student', 1),
    ('graduate', 'Graduate Student', 2),
    ('postdoc', 'Postdoc', 3),
    ('lecturer', 'Lecturer', 4),
    ('professor', 'Professor', 5),
    ('other', 'Other Position', 6)
ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;

-- A single-select, so a column on `posts` rather than a join table. This is the
-- deliberate opposite of `post_share_types`: that table exists because one post
-- really can offer a room *and* a car seat, whereas one post has exactly one
-- author with exactly one position.
--
-- NULL-able, even though both fields are required on the form. There is no
-- honest default for the posts that already exist — nobody can say what their
-- author's position was — and inventing one ('other', 'Unknown') would be
-- indistinguishable from an answer somebody actually gave. So the schema says
-- "not stated", the forms require an answer, and every renderer treats absence
-- as a normal state, exactly as it already does for share types.
ALTER TABLE posts ADD COLUMN position_slug TEXT REFERENCES positions(slug);

-- Only meaningful when position_slug = 'other'. The free text does not go into
-- position_slug itself: that would break the foreign key, make the curated list
-- unbounded, and turn "how many posts came from someone outside these five" into
-- a question nothing can answer.
ALTER TABLE posts ADD COLUMN position_other TEXT;

-- Free text on purpose. An institution list is not curatable — it is every
-- university, lab, museum, hospital and industrial research group on earth, in
-- several languages and with several names each — and a dropdown that does not
-- contain yours is worse than a box.
ALTER TABLE posts ADD COLUMN institution TEXT;
