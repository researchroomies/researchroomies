# ResearchRoomies – Development History

This is the detailed "why" behind each feature and hardening pass, moved out of
`CLAUDE.md` on 2026-08-23 because that file had grown past the 40k-character
limit Claude Code loads it under (it was 67,684 characters; most of the bulk
was this changelog). `CLAUDE.md` keeps the present-state reference material —
project overview, open decisions, backlog, architecture notes — plus a pointer
here. Nothing below is superseded; it's the record of how the current state
was reached, in roughly chronological order.

The six "Refactor Task" entries near the bottom also exist as their own files
in `docs/refactor/*.md`, each with a "✅ Landed" summary at the top — this copy
is kept for continuity with the rest of this changelog.

---

## D1 migrations + the subject-slug rename, 2026-08-15

`db/schema.sql` is **deleted**. The database is defined by `migrations/`, applied
in `NNNN_` order by `wrangler d1 migrations apply research-roomies --local|--remote`
and tracked in a `d1_migrations` table.

The old file was `CREATE IF NOT EXISTS` + `INSERT OR IGNORE`: idempotent for
*creation*, silently a no-op for *change*. It could not express "rename this
row", so editing the tag seed from five slugs to twelve changed new databases and
left production untouched — and nobody found out until a subject filter returned
nothing. That is the whole reason this exists.

| File | Does |
|---|---|
| `0001_baseline.sql` | Production as it stood before migrations. Every statement idempotent, so it is a no-op there and the real thing on a fresh database. Seeds the **five short** slugs, i.e. the drift written down rather than papered over. |
| `0002_canonical_subject_slugs.sql` | The rename: upsert 12 → repoint `conference_tags` → delete the 4 retired slugs. |
| `0003_share_types.sql` | The share-type tables and seed, separate because production does not have them yet. |

- **The twelve won over the five on product grounds, not aesthetics.** The five
  (`bio`, `chem`, `cs`, `math`, `physics`) are STEM-only; a cost-sharing site for
  academics that cannot list humanities, social sciences or education excludes
  the fields with the thinnest travel budgets. `physics` is already correct and
  is deliberately not renamed — only four slugs move.
- **Insert → repoint → delete, not `UPDATE tags SET slug`.** `conference_tags.tag_slug`
  is a foreign key with no `ON UPDATE CASCADE`; this ordering never leaves a
  dangling reference, so it is correct whether or not D1 is enforcing FKs.
  `UPDATE OR REPLACE` on the join table collapses the one possible primary-key
  collision (a conference tagged both `cs` and `computer-science`); plain UPDATE
  would abort the migration and `OR IGNORE` would silently drop the tag.
- **Upsert, not `INSERT OR IGNORE`, for the seeds.** Production's stored tag
  *names* were never in version control, so IGNORE would have left whatever was
  there. `ON CONFLICT(slug) DO UPDATE SET name = excluded.name` makes the end
  state independent of the starting state — proven in the rehearsal below, where
  `Bio` became `Biology`.
- **The test suite reads `migrations/`,** not a separate schema file
  (`test/helpers/seed.ts` globs and concatenates them). One definition of the
  database, and a migration that does not produce a working schema fails the
  tests rather than the deploy. `test/migrations.test.ts` pins the end state: 12
  subjects, no surviving short slug, every subject named, non-STEM present.

**Rehearsed against a local D1 seeded to look like production** — schema, the
five short slugs with deliberately wrong names (`Bio`, `CS`), `conference_tags`
rows pointing at `cs`/`bio`, and no `d1_migrations` table. After
`migrations apply`: 12 tags, 0 stale slugs, names corrected, join rows repointed
to `computer-science`/`biology`, 0 orphans, 5 share types. Re-applying reports
"No migrations to apply". A fresh database run through the same chain lands in
the identical state.

**To deploy:** `npx wrangler d1 migrations apply research-roomies --remote`, then
`npm run deploy`. Migrations first — `0003` creates tables the new code queries.

---

## Share types — one post can offer several things, 2026-08-15

A post now records **what it is offering to share** as data rather than only as
prose: `lodging`, `carpool`, `rental-car`, `airport-transfer`, `other`. It is a
multi-select — the case the feature exists for is one post offering a spare bed
*and* two seats in the car, which previously could only be said in the
description where nothing could filter or label it.

- **`post_share_types` is a join table, not a column on `posts`.** That is what
  makes "both" representable. The `/search?share=` clause is
  `posts.id IN (SELECT post_id …)` — membership, so a post offering two things
  answers to a filter on either, and it cannot return the post twice the way a
  JOIN would.
- **`setShareTypesForPost()` replaces the set; `tagConference()` only adds.**
  The difference is deliberate and is the subtlest thing in the feature:
  unchecked boxes submit *nothing*, so an add-only write makes removing a share
  type look like it worked and silently do nothing. The `DELETE` runs
  unconditionally, including when no slugs were submitted, and the whole thing
  goes through `batch()` so a post is never left cleared-but-not-rewritten.
- **The picker is on the edit form, not only on create.** This is the direct
  lesson of the subject-tag bug still in the backlog: subjects can only be set
  while creating a *new* conference, so every conference that predates the
  feature is permanently untaggable and `/search?tag=` finds nothing on
  production. Every post can be typed from `/post/:id/edit` whenever it was
  written, so share types have no equivalent dead population.
- **`renderShareTypePicker()` returns `string | null`, and the two callers treat
  null differently on purpose.** The create fragment degrades to no picker (the
  field is optional and nothing is saved yet); the edit form returns
  `errorPage()`, because its write is replace-all and rendering the form without
  its checkboxes would make the next save wipe the post's existing types.
- **Checkboxes, not `<select multiple>`.** The subject picker beside it is a
  multi-select with a "hold Ctrl" hint, and that hint is the tell: it hides
  multi-selection behind a keyboard convention, on the one form whose whole
  point is that you may pick more than one.
- **`sort_order` on `share_types`.** `tags` orders by name; this list cannot,
  because 'Other' has to come last and alphabetical puts it in the middle.
- **`handleMyPosts` moved to its own module.** Adding badges pushed `posts.ts`
  to 334 lines, over `test/route-modules.test.ts`'s 320 bound. The bound's own
  failure message says to split rather than raise the number, and the seam it
  asks for was already there: everything left in `posts.ts` mutates a post,
  while `/my-posts` renders a listing like `/search`. Pure move, `posts.ts` is
  now 269.
- **Cover is `test/share-types.test.ts` (17 tests).** Checked against mutation:
  making the write add-only fails the two replace-semantics tests, dropping the
  curated-list filter fails two more, and an exclusive-match search clause fails
  the multi-type filter tests. Verified end to end against `wrangler dev` as
  well — badges on `/search` and `/post/:id`, `?share=carpool` returning the
  multi-type post and excluding the untyped one.

**Closed by the Classical redesign (2026-08-17):** the conference page shows
badges too. It keeps the narrow `Post` type — no widening — and reads them with
one `listShareTypesForPosts()` call over the ids it already has, the same way
`/search` does. That same map also supplies the share-type counts in the row
above the list, so the badges and the counts cannot disagree.

---

## The all-conferences index, 2026-08-16

`GET /conferences` is every conference in the database, grouped by subject —
the first page that answers "what is on here?" without already knowing a
conference name or a subject slug. `handleAllConferences` lives in
`src/routes/conferences.ts` beside the singular page, which all three conference
browsing surfaces now share.

**That module was at 313 lines against `test/route-modules.test.ts`'s 320-line
bound** — seven lines of headroom, so the next addition to it would fail the
suite. It was left unsplit because it was not yet over and the seam was weak: an
index, a detail page and a featured fragment are one concern in a way that
`/my-posts` and post authoring were not. The redesign was the next addition, and
the split went the way this note called: `/conferences` and its grouping out to
`src/routes/all-conferences.ts`, rather than raising the number.

**Nothing linked to it at first.** That was deliberate and was the request: a
redesign was coming and the navigation was its problem. The Classical redesign
(2026-08-17) put "Conferences" in the nav, so it is now a first-class browse
surface; it also split the handler out to `src/routes/all-conferences.ts`,
exactly as the size note below predicted.

- **A conference with two subjects appears under both.** Subjects are a
  many-to-many, so one bucket per conference would mean inventing a "primary"
  subject the data does not have, and would hide a joint bio/CS conference from
  one of the two audiences looking for it. The page is a browse index, not a
  count of conferences — the intro line says so, because the total and the
  number of listed rows deliberately disagree.
- **Untagged conferences get a trailing "No subject yet" group.** This is the
  decision the page turns on: on production almost nothing is tagged (subjects
  can only be set while creating a conference, so everything older is
  permanently untaggable — see the backlog), and a strict grouping would render
  a nearly empty page against the live database while looking correct in tests.
  Last, so the page does not lead with the gap.
- **Empty subjects are omitted**, rather than rendered as twelve empty headings.
  The nav already lists every subject; this page shows what is actually there.
- **`tag: null` for the untagged group, not a synthetic tag row.** A made-up
  slug would render as a heading link to a `/subject/:slug` that 404s.
- **Two queries regardless of size**, `listAllConferences()` then
  `listTagsForConferences()` — the same shape as `listShareTypesForPosts()` and
  for the same reason. Reading subjects per conference would be a query per row.
- **The subjects are deliberately not joined into the counting query.** Adding
  `conference_tags` to it fans the rows out one per (conference, subject) pair
  and multiplies `COUNT(posts.id)` by the number of subjects — a conference with
  three subjects and three posts reports nine, which is a plausible-looking
  number rather than an obvious fault. That is the mutation the post-count test
  exists for.
- **`listAllConferences()` has no `LIMIT`,** unlike `listFeaturedConferences()`.
  This is the page whose whole job is to be the complete list, so a cap would
  make it quietly lie; if the table outgrows one scan the fix is pagination in
  the handler, not a silent cap in the query.
- **`renderIndexItem()` is a near-twin of the list item `/subject/:slug`
  renders, and stays duplicated.** A two-line template shared by two pages is
  not worth the cross-module import the route-module rule bans.
- **`/conferences` and `/conference/*` do not collide.** `run_worker_first`
  rules are anchored at both ends, and the wildcard requires the slash, so the
  plural index is neither covered by the singular rule nor in conflict with it.
  It is listed separately in `wrangler.toml`; `test/assets.test.ts` checks that
  automatically from `ROUTES`.

**Ordering carries an inherited wart.** Conferences are sorted `start_time ASC`
to match `listConferencesForTag()`, which puts *finished* conferences at the top.
That is the sibling page's existing behaviour rather than a choice made here, and
changing it belongs in both queries at once so the two pages cannot disagree —
worth folding into the redesign.

**Cover is `test/all-conferences.test.ts` (15 tests).** Checked against
mutation: fanning the count query out over `conference_tags` fails the
post-count test, dropping the untagged group fails two, grouping under only a
conference's first subject fails two, and neutering the group comparator fails
the ordering test. That last one initially passed under mutation — the seeded
conference names happened to sort in the same order as their subjects, so
insertion order was already alphabetical and the test proved nothing. It now
sets explicit start dates that make the groups arrive in reverse.

**Verified end to end against `wrangler dev`,** which is the part the handler
tests cannot reach: `/conferences` returns 200 through the real asset router
rather than being shadowed, the joint conference renders under both of its
subjects, the untagged conference lands in the trailing group, counts read
`1 post` / `0 posts`, `/conferences/` 308s to the slashless form, and
`/conference/:slug` still resolves and still 404s on a bad slug.

---

## The Classical redesign, 2026-08-17

The whole site was restyled from the Claude Design mockup
(`ResearchRoomies Restyle.dc.html`, project `a795def1`) onto the **Classical**
design system: Cormorant Garamond over Lora on a warm near-white ground, a single
gold accent applied as *stroke* rather than fill, hairline rules instead of boxes
and shadows. `templates/style/style.css` was replaced wholesale — 380 lines of
ad-hoc rules became a token block, the system's component layer, and an
application layer, in that order and each building only on the ones above it.
The layering and the container-class table are documented in AGENTS.md.

**No framework, and no new JavaScript.** That was the explicit request and it
held: the only script on the site is still HTMX and the Turnstile widget. Two
things the mockup drew as interactive are links instead, because a link is the
frameworkless answer:

- **The search page's filter chips.** Each chip's "×" is a link back to
  `/search` with that one parameter dropped. The page's entire state is already
  in the query string, so removing a filter needs no script and no endpoint.
- **The conference page's share-type row.** Rendered as `.seg-opt` links into
  `/search?conference=…&share=…`. The counts are computed from the badges the
  page has already loaded, so the row costs no extra query — but an in-page
  filter would have needed either a script or a second fragment route.

### What moved, and why

- **`handleAllConferences` split into `src/routes/all-conferences.ts`.** The
  previous section in this file predicted this: `conferences.ts` sat at 313
  lines against `test/route-modules.test.ts`'s 320 bound, and named the seam to
  cut when something was next added to it. The restyle was that something. Pure
  move — grouping, rendering and handler — leaving `/conference/:slug` and the
  featured fragment behind. `conferences.ts` is 254 after the restyle and
  `all-conferences.ts` 212.
- **`getPostWithConference()` widened** to select `posts.created_at` and the
  conference's `location_address` / `start_time` / `stop_time`. The post page
  now states them as a definition list beside the description, which is the
  first thing a reader wants to know about a room share. The ownership guard and
  the report form ignore the added columns — the same deliberate widening Task 3
  made rather than keeping two near-identical shapes apart.
- **`listFeaturedConferences()` gained a post count**, so a featured card can
  say "9 open posts". As in `listAllConferences()`, `conference_tags` is
  deliberately not joined in: it would fan the rows out one per
  (conference, subject) pair and multiply the count.
- **`listRecentPosts()` is new**, and is the one thing that distinguishes the
  homepage feed from an unfiltered `searchPosts()`: that query sorts by
  conference start date so a search reads as an itinerary, while the feed
  answers "what has been posted lately" and sorts by `created_at DESC`.
- **`/search` stopped fetching its own subject options over HTMX.** The page is
  Worker-rendered, so both lists are one more `await` instead of two round
  trips — and the chips need the *display names* anyway, which the fragment
  never handed back. `/api/components/tag-options` stays: the static home and
  create pages still use it.

### What the mockup asked for and did not get

The mockup's own "what this asks of the code" notes flagged these, and each was
cut for the reason it gave rather than faked:

- **"2 inquiries" per post on `/my-posts`, and dimming a post whose conference
  has passed.** The first needs a count query over `message`, which is currently
  write-only; the note said "or cut them". The page shows a real
  "N posts · M for upcoming conferences" line computed from the rows it already
  has instead.
- **Per-kind counts on the featured cards** ("6 lodging · 3 carpool"). The total
  is there; the breakdown would be a query per card. The conference page shows
  the breakdown, where it is free.
- **"Email me when new posts appear"** — there is no subscription concept in the
  schema, and inventing a button that does nothing is worse than omitting it.
- **A post `kind` column.** Share types already are that, as a many-to-many, and
  the mockup's later section is caught up to them.

### Two fixes after the first look

- **The wordmark rendered at 14px**, the same size as "Browse" beside it. `.nav a`
  sets `font-size: 14px` and is both later in the stylesheet and one specificity
  point above a bare `.nav-brand`, so the brand's own 22px never applied. It is
  `.nav a.nav-brand` at 28px now, with a comment saying why the qualifier is
  load-bearing — this is the failure mode where the rule looks correct in the
  file and is simply never used.
- **The homepage's featured section was mislabelled** "Conferences with open
  posts". It has always been `is_featured = 1` — an admin's curated shortlist,
  set by hand in D1 — and the two are not the same set in either direction: a
  featured conference may have no posts, and most conferences with posts are not
  featured. The heading now reads "Featured conferences" with a line pointing at
  `/conferences` for the complete list. The featuring mechanism (and the exact
  `wrangler d1 execute` to use, since there is no admin UI) is written down in
  the `conferences` table section of AGENTS.md.

### Chrome changes

`renderShell()` now renders `<header class="site-header">` with a `.nav` row —
brand, Browse, Conferences, Create post, then the account fragment — over a
subject strip carrying `#nav-subjects`. **`/conferences` is finally linked**,
which the all-conferences section left as the redesign's problem. The footer
gained How it works and the standing "we introduce people and nothing more"
line. `test/shell.test.ts` slices `<head>` and `<footer>` by their bare tag
names, so both must stay attribute-free — the classes go on a wrapper inside.

### Cover

All 447 tests pass unchanged except `test/all-conferences.test.ts`, whose HTML
parsers keyed on `<h3>` headings and a `· N posts` separator that the new markup
does not have. The assertions are the same; only the selectors moved. One
behaviour did change with it: a conference with no posts now reads
"No posts yet" rather than "0 posts", because the count is the reason to click
through and a conference nobody has posted for should say so in words.

**Verified end to end against `wrangler dev`** on a seeded local D1 — every page
and fragment at 200, the filter chips each dropping their own parameter, the
share-type counts matching the badges, `/my-posts` and the edit/delete/report
forms behind a minted session cookie, and the static pages through the real
asset router.

---

## Position and institution on a post, 2026-08-18

A post now says **who wrote it**: a required position from a curated list of six
(`undergraduate`, `graduate`, `postdoc`, `lecturer`, `professor`, `other`) and a
required free-text institution. `other` opens a free-text box of its own. Both
appear on the create form, on the edit form, and on every surface that shows a
post. This was feedback: readers were being asked to arrange a shared hotel room
with someone whose only stated identity was an email address.

- **Post-level, not user-level.** `users` holds an email and nothing else, its
  only writer is the login upsert, and the site has no profile page — a column
  there would have no UI and no way to be corrected. The post is also the honest
  scope: a position is true as of the trip being arranged, and the author who was
  a graduate student for the 2026 conference is a postdoc for the 2027 one.
- **`positions` is a curated table; `posts.position_slug` is a column.** The
  table is the direct sibling of `share_types`, down to `sort_order` — the list
  runs earliest career stage to latest and ends at 'Other Position', which
  alphabetical would bury in the middle. The *column* is the deliberate contrast
  with `post_share_types`: that is a join table because one post really can offer
  a room and a car seat, whereas one post has exactly one author with one
  position.
- **`position_other` is a second column, not free text in `position_slug`.**
  Putting the typed answer in the slug would break the foreign key, make the
  curated list unbounded, and turn "how many posts come from someone outside
  these five" into a question nothing can answer. `resolvePosition()` clears the
  free text whenever the slug is not `other`, because the hidden box keeps its
  value in the DOM — a user who types "Staff scientist", reconsiders and picks
  Professor submits both, and storing the leftover would produce a row claiming
  to be a Professor with an 'other' label attached.
- **The columns are nullable although the fields are required, and this is the
  central decision.** SQLite cannot add a NOT NULL column without a default, and
  there is no honest default: nobody can say what the author of an existing post
  was, and `'other'` / `'Unknown'` would be indistinguishable from an answer
  somebody actually gave. So the schema says "not stated", the forms require an
  answer, and every renderer treats absence as normal — exactly as it already
  does for share types. The consequence to keep in mind is the join:
  `LEFT JOIN positions`, never `JOIN`, or every post written before this feature
  disappears from every listing while the happy-path tests still pass.
- **Required means rejected, not dropped.** This is the first field on the site
  whose bad input is a 400. `setShareTypesForPost()` silently discards a slug
  outside its list because share types are optional — discarding one leaves a
  post the author could have written. Discarding a position would write a post
  with no position through a form that says the field is mandatory, so
  `resolvePosition()` returns null and `readAuthorFields()` turns that into the
  400.
- **The check runs after Turnstile and before the conference branch.** After,
  because it reads the database and an unverified request should not get that
  far. Before, because creating a post against a *new* conference is three
  unprotected writes — rejecting afterwards leaves an orphan conference that has
  already taken its slug, so the author's corrected retry comes back as `…-2`.
  `test/positions.test.ts` pins both ends of that window.
- **The picker is on the edit form, which is what keeps the population alive.**
  Same lesson as share types, restated because it is the one that actually bit:
  subjects can only be set while creating a conference, so everything older is
  permanently untaggable and `/search?tag=` finds nothing on production. Here a
  post that predates the fields is one save away from being complete.
- **The reveal is an inline `onchange`, and there is still no new JavaScript.**
  The create page already toggles its new-conference block exactly that way. The
  handler also sets `required` on the free-text box rather than the markup doing
  it: a `required` field that is `hidden` blocks submission with a browser
  message pointing at a control nobody can see. The server enforces the same rule
  regardless, so the attribute is a courtesy, not the check.
- **`renderAuthorFields()` returns `string | null` and *both* callers treat null
  as fatal** — unlike `renderShareTypePicker()`, whose create-form caller
  degrades to no picker. A form rendered without a required field is one whose
  save can only 400, which would cost the author everything else they had typed.

### What moved

- **`handleCreatePost` split into `src/routes/create-post.ts`.** Adding the
  fields took `posts.ts` to 360 lines against `test/route-modules.test.ts`'s 320
  bound, and the bound's own message says to split rather than raise the number.
  The seam is `requireOwnedPost()`: everything left in `posts.ts` starts from a
  post that exists and belongs to the caller and touches nothing else, while
  creating one starts from a session and may write a conference, its subjects,
  the post and its share types before it returns. `posts.ts` is 194 after the
  split and `create-post.ts` 146.
- **`readAuthorFields()` lives in `src/lib/positions.ts`, not in a route
  module,** so create and edit cannot disagree about what is required — the same
  file that puts that knowledge into the markup. It returns
  `{ ok, value | response }` following `lib/guards.ts` rather than throwing.
- **Every post read gained the authorship columns.** `Post`, `PostWithConference`
  and `PostDetail` all carry `position_name` / `position_other` / `institution`;
  `PostDetail` additionally carries `position_slug`, because only the edit form
  needs to re-select an `<option>` and a display name cannot do that. The name is
  resolved by a join in the query rather than a lookup per row — the same rule
  `listShareTypesForPosts()` follows. It cannot fan the rows out the way
  `conference_tags` would: `position_slug` is a single value against a primary
  key.
- **`test/helpers/seed.ts` now tracks migrations** in a `d1_migrations` table
  instead of concatenating every file and re-running the lot on each reset.
  Everything up to `0003` was idempotent by construction, so the blob happened to
  work; `ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS` form and fails outright
  the second time. `seedPost()` leaves the new fields null by default — a post
  written before the feature — so a renderer that cannot survive a null cannot
  pass the suite.

**Cover is `test/positions.test.ts` (28 tests); the suite is 495 across 16
files.** Checked against mutation: turning the LEFT JOIN into an inner one fails
five tests (every "post that predates the fields" case), making
`resolvePosition()` fall back to a default instead of rejecting fails three, and
moving the author check after the conference branch fails exactly the orphan
test. Two existing guard tests moved with the code rather than being weakened —
`db-access.test.ts` gained `src/db/positions.ts` in its list of SQL-holding
modules, and `session-access.test.ts`'s `UPDATE posts SET … WHERE id = ? AND
user_id = ?` regex became `[\s\S]*?` because that statement wrapped onto several
lines when it gained columns.

**Verified end to end against `wrangler dev`** on a local D1 carrying the earlier
migrations: `0004` applied to the existing database and re-applying reports "No
migrations to apply"; the fragment, both creates (curated slug and Other +free
text), all four rejections at 400 with nothing written, the post page's two fact
rows, the free text shown in place of the words "Other Position", a legacy post
still rendering at 200 with the rows omitted and no byline in any listing, the
byline on `/search`, `/my-posts`, `/conference/:slug` and the home feed, the edit
form pre-selecting each of the three states, a legacy post completed through it,
and an edit that drops the institution refused at 400 with the row unchanged.

**To deploy:** `npx wrangler d1 migrations apply research-roomies --remote`, then
`npm run deploy`. Migrations first, as always — `0004` adds the columns the new
queries select, and the deployed Worker would 500 on every listing without them.

**Deliberately not built:** a `/search?position=` filter. The data now supports
it and the clause would be one line, but nobody asked to search by career stage,
and every filter added to that page is another chip, another parameter and
another combination for `test/search.test.ts` to cover.

---

## The `.edu` gate, turned on — 2026-08-23

Feedback item 7 had been built as a switch back on 2026-08-10 and left off, with
a standing recommendation in `CLAUDE.md` to keep it off until real spam showed
up. Eric decided otherwise. `RESTRICT_EDU_EMAILS` is now `"true"` in
`wrangler.toml`, and the same commit gave the refusal and the send-confirmation
a dialog each on `/login`.

**What the flag actually costs, measured rather than assumed.** The standing
worry in the note was international academics — `.ac.uk`, `.edu.au`, and
universities with no `.edu` domain. A read of the production `users` table found
none: all seven non-`.edu` accounts of the twelve are consumer mail, three on
`gmail.com` (three posts between them) and four on privacy providers
(`protonmail.com`, `proton.me`, `startmail.com`, `duck.com`) that look like
development accounts. So the exclusion the note was written to warn about is not
the exclusion that happened. The one that did: **Eric's own
`ejyager00@protonmail.com` is locked out by this**, and there is no admin path
back in — the gate is the login, so an excluded account cannot be recovered from
inside the app. Flipping the flag to `"false"` for one deploy, or logging in
with a `.edu` address, are the two ways through.

**Why the refusal copy lives in `src/lib/auth.ts` and not on the login page.**
`/login` is an Eleventy page — it is built at deploy time and knows nothing
about `env`. The dialog still had to be scoped to "only when the restriction is
on", so the page could not simply own the text. `EDU_RESTRICTION_MESSAGE` is
exported next to `isEmailAllowed()`, `handleAuthStart` returns it as the body of
its 403, and the page renders whatever body a 403 carries. That makes the status
code the scoping mechanism: 403 is the only refusal `handleAuthStart` can
produce and it can only happen while the flag is on, so the dialog is correct in
both flag states without the build ever reading the var. The cost is a coupling
worth knowing about — a second 403 added to that handler would put the .edu
words in front of someone it does not apply to. `test/edu-gate.test.ts` asserts
the status, the body, and that the gate refuses *before* the mailer, so a
blocked address never receives a login email it cannot use.

`handleAuthCallback` uses the same constant. It had its own near-duplicate
wording before, pointing at `admin@researchroomies.com`; both copies are now the
one message. Dropping the admin pointer was deliberate — the new copy is what
Eric supplied, and it ends on the apology rather than an escape hatch.

**The second dialog is client-only, on purpose.** The mail-delivery warning
(institutional mail servers delay or spam-file the first login email) is shown
after a successful send and is never needed by the server, so it lives as a
constant in `login.njk` rather than travelling over the wire for no reason.

**Turnstile resets on every failure path now.** Not cosmetic: the token is
single-use, and the page previously reset the widget only on success. A refused
address — which is now a routine outcome rather than an impossible one — left
the user holding a spent token, so their corrected retry failed on the bot check
instead of the email. Every branch that ends without a login calls
`resetTurnstile()`.

**`.dialog` is a new layer-2 component in `style.css`,** a native `<dialog>`
element. Nothing here re-implements a focus trap, an Esc handler or a backdrop;
the browser supplies all three and only the skin is ours. `showModal()` is
feature-detected with a fallback to the existing inline message div, so an old
browser degrades to the pre-change behaviour rather than a dead submit button.

**Verification:** 503 tests across 17 files (up from 495/16 — `edu-gate.test.ts`
is the new file), `npm run build` and `tsc --noEmit` clean.

## Trailing-slash 404 on every Worker route — fixed 2026-08-10

Reported as "search only works when logged in." Search has **no** login
dependence: `/search` is byte-identical with and without a session cookie
(verified by diffing responses against `wrangler dev` with a minted session),
and anonymous search returns results on production. The real fault was the URL,
not the session.

Routes are registered without a trailing slash and `Router.match()` anchors its
pattern with `$`, so `/search/` missed the router, fell through to
`env.ASSETS.fetch()`, and hit `not_found_handling = "404-page"`. This affected
every Worker route — `/my-posts/`, `/post/:id/`, `/subject/:slug/` all 404'd.

`/search/` is not a hypothetical URL: Eleventy emits directory-style pages, so
that is exactly where the old static search page lived, and it persists in
bookmarks, history and URL autocomplete. Which form you land on is per-browser-
profile, which is what made it look correlated with login state.

`src/index.ts` now redirects `308` to the canonical slashless path, but **only
when trimming reveals a registered Worker route** — real assets are
directory-style (`/about/`, `/login/`), so those must keep falling through
untouched. 308 rather than 301 so POST routes like `/post/:id/edit/` do not
degrade into a GET. Covered by `test/routing.test.ts`.

### Fixed in the same feedback round

- **Asset shadowing of `/search`.** `templates/pages/search.njk` built to `public/search/index.html`, and Cloudflare serves a matching asset *before* invoking the Worker, so `handleSearch` never ran. The template is deleted, `/search` is listed in `run_worker_first`, and search now filters on keywords (`q`), conference name, subject tag, and date range. `conference.njk` and `subject.njk` were deleted for the same reason — all three were Eleventy shells the Worker fully renders.
- **Route registration is no longer prefix-guessed.** `src/index.ts` used a hand-maintained `/^\/(api|conference|post)\//` regex to decide what was dynamic. It now asks `router.match()`, so a registered route can never be stranded behind a stale regex again.
- **Turnstile was inert.** The client script only loaded on `/login`, so create-post and inquiry forms never produced a token — and both handlers used `if (token) { verify }`, silently skipping the check. The script went into both page shells (one shell since Task 4), and `verifyTurnstile()` in `src/lib/turnstile.ts` treats a missing token as failure.
- **Stored XSS.** Post titles, descriptions, conference names, locations, and page titles were interpolated raw. Everything now goes through `escapeHtml()` from `src/lib/html.ts`.
- **Nav login state on Worker-rendered pages.** `renderFullPage()` was a drifted copy of `base.njk` missing `#nav-user-state`. Both now render the same nav, with user state and subject links as HTMX fragments.
- **Conference slug collisions.** `generateUniqueSlug()` suffixes duplicates (`-2`, `-3`), backed by a `UNIQUE` index.
- **Dead surface built out.** Subject tags (curated seed list, conference-level, browsable at `/subject/:slug`), post reporting into `flags` with an admin email, and inquiry persistence into `message`.
- **Deploy safety.** `npm run deploy` is now `npm run build && wrangler deploy`; it previously shipped whatever stale HTML was in `public/`.

---

## Round 2 — hardening pass, 2026-08-10

- **HTML injection into inquiry emails.** `sendInquiryEmail` interpolated `postTitle` and `messageContent` raw into the HTML body a third party receives. Now escaped via `escapeHtmlForEmail()`, as `sendReportEmail` already was.
- **D1 error text leaked to clients.** `handleCreatePost` returned `"Internal Server Error: " + err.message`, which surfaced constraint and table names. Generic 500 now; details stay in `console.error`.
- **`handleAuthCallback` had no try/catch.** A `throw` mid-login escaped the handler and became the runtime's bare 500 with no page — from a link clicked in an email. Wrapped, and its failure responses are now rendered pages pointing back at `/login`.
- **`handleSubjectPage`'s tag lookup sat outside its own try block**, so a D1 failure there was an unhandled 500 while the identical failure one query later rendered an error page.
- **`handleReportForm` was a post-existence oracle.** It queried the post *before* checking the session, so an anonymous caller got 302 for a real post id and 404 for a missing one. Session check now comes first, matching every other handler.
- **`parseInt()` id validation was ineffective everywhere.** `parseInt("12abc", 10)` is `12` and `Number.isFinite()` accepts it, so malformed URLs resolved to unrelated rows. `parseRouteId()` in `src/lib/params.ts` requires all digits; `api.ts`, `posts.ts` (`parsePostId`) and `flags.ts` all route through it. Covered by `test/params.test.ts`.
- **`/post/:id` is server-rendered.** It was the last page on the static-shell pattern: `post.njk` shipped "Loading post details…" plus inline JS that re-parsed the id out of `window.location` to fetch `/api/components/post/:id` — three round trips, and crawlers and link unfurlers never saw a title or description for the site's primary entity. `handlePostPage` now renders directly, with `<meta name="description">` and OpenGraph tags. `templates/pages/post.njk` is deleted. `/api/components/post/:id` is retained deliberately so old shells still in browser caches degrade to a working page.
- **`renderFullPage()` takes an options object** (`description`, `canonicalUrl`) — the equivalent of `base.njk`'s `{% block head %}`. It still owns the title suffix, so callers pass a bare title.

---

## Refactor Task 1 — response module + route-ownership guards, 2026-08-10

Two invariants that used to live in prose are now tests, and HTML responses have one construction path.

- **`src/lib/response.ts` is the only place an HTML response is built.** `pageResponse` / `fragmentResponse` / `htmlResponse`, plus `notFoundPage()` / `forbiddenPage()` / `errorPage()`, which used to be private to `posts.ts` while `api.ts` and `flags.ts` hand-rolled their own. `charset=utf-8` is written once (it was 29 sites saying `text/html` and 12 saying `text/html; charset=utf-8`). Cache policy is a closed union — `'public-short'` / `'public-long'` / `'private'` / `'none'` — **defaulting to `'private'`**, so caching a session-varying fragment publicly takes a deliberate act.
- **`errorPage()` takes no argument.** Round 2 fixed a handler that returned `"Internal Server Error: " + err.message` and leaked D1 constraint and table names; there is now no parameter to put them in.
- **The route table moved to `src/routes.ts`.** `src/index.ts` went 93 → 39 lines and holds only the fetch handler, the trailing-slash 308, and the asset fallthrough. `ROUTES` is importable, which is what makes the guard tests possible.
- **`test/assets.test.ts` guards asset shadowing and `run_worker_first`.** It reads `ROUTES` directly, so a new route is checked automatically. It failed on first run for six routes — `/conference/*`, `/subject/*` and `/post/*` were missing from `wrangler.toml` and have been added. Its wildcard matching mirrors Cloudflare's own asset rules engine (`*` crosses `/`, so `/post/*` covers `/post/1/edit`) rather than guessing.
- **Two vitest projects now.** The guard tests need `node:fs` to read `public/` and `wrangler.toml`, which workerd does not have. `vitest.config.mts` declares a `workers` project and a `node` project; plain `npx vitest run` runs both — do not narrow it. They fail loudly rather than skipping when `public/` is absent.
- **Deliberate behaviour changes:** fragments gained `charset=utf-8`; responses that previously sent no `Cache-Control` now send `no-store` (404/500 pages and error fragments only); per-handler 404/500 copy collapsed into the generic shared text.

---

## Refactor Task 5 — configuration module, 2026-08-10

`src/lib/config.ts` is now the only place a deployment literal lives. `getConfig(env, request?)` returns `origin`, `sessionTtlSeconds`, `magicLinkTtlSeconds`, `turnstileSiteKey`, `mailgun` and `adminEmail`. Every default reproduces the literal it replaced, so an existing deployment that sets none of the new vars is unaffected.

- **The session TTL had two definitions** — `lib/auth.ts` set the token's `exp`, `routes/auth.ts` set the cookie's `Max-Age`, and they agreed by coincidence. Divergence is a silent logout. One constant now, and `handleAuthCallback` derives both from a single local. Verified end-to-end, not just by reading: `exp - iat` = 2592000 = the cookie's `Max-Age`.
- **The origin is derived from the request** (`APP_ORIGIN` overrides), so a staging deployment links to itself instead of to production. Note the `wrangler dev` caveat in the backlog.
- **The Turnstile sitekey has one definition**, `TURNSTILE_SITE_KEY` in `[vars]`. Worker forms call `turnstileWidget(env)`; Eleventy pages use a `{{ turnstileSiteKey }}` global that `eleventy.config.js` reads back out of `wrangler.toml`, failing the build if it is missing. `TURNSTILE_SECRET_KEY` stays a secret.
- **`MAILGUN_SENDING_KEY` was documented, not renamed.** It is a From address, not a key, but renaming it means rotating a deployed secret by hand for no functional gain. `config.mailgun.from` carries the correct meaning; the var keeps the wrong name.
- **The "valid for 15 minutes" copy is generated** from `MAGIC_LINK_TTL_SECONDS`, in both email bodies and the expired-link page, so it cannot drift from the token.

---

## Refactor task 4 — the two page shells are now one, 2026-08-10

`renderFullPage()` and `base.njk` were hand-maintained copies of the same chrome, kept together by a paragraph in this file. The chrome now lives once, in **`renderShell()` (`src/lib/shell.mjs`)** — plain ESM so the Worker bundle, the build script and the test suite can all load it. `renderFullPage()` is a thin call into it (unchanged signature), and `scripts/gen-layout.mjs` generates `templates/layouts/base.njk` from it ahead of Eleventy in `npm run build`.

`base.njk` is committed with a `{# GENERATED FILE #}` banner rather than gitignored, so `npx vitest run` works on a fresh clone. `test/shell.test.ts` reads the committed layout, substitutes the same Nunjucks markers the generator emitted, and asserts the result is byte-identical to `renderFullPage()` — head, footer, and whole document. A hand-edited or stale layout fails the suite.

Three live bugs closed with it:

- **Blank copyright year on every built page.** `base.njk` rendered `{{ year }}` with nothing defining it, so static pages shipped `© ResearchRoomies` while Worker pages showed the year. `eleventy.config.js` now supplies `year` (and `siteOrigin`) as global data.
- **No meta on static pages.** About, Terms, Privacy, Safety, How It Works, Login, Create, Home and 404 had no description, no OpenGraph tags and no canonical link — they produced no link preview at all. Each page now carries `title` and `description` front matter; the shell builds the tags, and canonical/`og:url` come from `siteOrigin` + `page.url`.
- **Two title contracts.** The nine `.njk` pages each wrote their own full title, seven with a hyphen and two with an en dash, while `renderFullPage()` appended ` – ResearchRoomies` itself. Pages now supply a bare `title` in front matter and the shell appends the suffix, one way, everywhere.

---

## Refactor Task 2 — auth and ownership guards, 2026-08-11

`src/lib/guards.ts` is now the only thing that resolves a session. It went in
because one condition — "not logged in" — had three different answers spread
across ten handlers with the rule written down nowhere, so a new handler picked
one at random.

- **The three failure modes are documented on the `GuardMode` type**, and only
  there. `requireUser(request, env, mode)` with `'page'` → 302 to `/login`,
  `'api'` → 401 plain text, `'htmx'` → 200 + `HX-Redirect`. Each of the ten
  converted handlers keeps the mode it already had; the shapes were checked
  against `wrangler dev`, not just read.
- **Guards return a value, not a throw.** `{ ok: true, value } | { ok: false,
  response }`, so the failure stays an ordinary `return` at the call site and no
  guard has to know whether it sits inside a `try`.
- **`requireOwnedPost()` replaces four hand-written copies** of session → parse
  id → fetch row → compare `user_id`. `posts.ts` went 258 → 140 lines and now
  contains no ownership comparison at all. The `AND user_id = ?` clauses stay on
  the `UPDATE`/`DELETE` as defence in depth — the guard makes them redundant,
  not wrong.
- **`optionalUser()` is the deliberate-anonymity path**, for `/post/:id`, the
  component fragment and the nav, which render for anyone but differ for the
  author. Its existence is what makes "no `getSessionUser` outside guards" a
  rule with no exceptions worth arguing about — `handleAuthMe` is the single
  documented one, because reporting the raw session is its entire purpose.
- **The login route no longer hand-rolls siteverify.** `handleAuthStart` called
  `fetch()` against Cloudflare directly, which meant the one route where a
  Turnstile bypass matters most was the one route not going through the module
  written to prevent exactly that. It calls `verifyTurnstile()` now.
- **`flags.ts`'s 400-vs-404 split is decided: 404.** A malformed post id and a
  missing post are the same thing to the caller, and `posts.ts` already said
  404. Both flags sites moved (the GET's 400 error page and the POST's bare
  `"Invalid post"` text).
- **`test/session-access.test.ts`** holds all three invariants as greps over
  `src/`: no `getSessionUser` outside the two allowed files, no `user_id !==` in
  `posts.ts`, no `siteverify` outside `lib/turnstile.ts`. It strips comments
  before matching, so a comment explaining a rule does not trip it. Runs in the
  node project alongside `assets.test.ts`; `vitest.config.mts` now shares one
  `NODE_ONLY` list between the two projects instead of naming the file twice.
- **Deliberate behaviour change beyond the auth table:** the two mutating
  handlers in `posts.ts` returned bare `"Internal Server Error"` text on a D1
  failure while their GET siblings rendered the error page. They are plain form
  POSTs whose response the browser displays, so both now return `errorPage()`.

---

## Refactor Task 3 — repository module, 2026-08-12

`src/db/` is now the only place a SQL statement lives: 27 `DB.prepare()` call
sites holding ~28 statements moved out of the handlers into six modules by
table. `routes/api.ts` went 1074 → 804 lines. **The handler tests are the
payoff** — before this there were zero, because exercising a handler meant
standing up a database by hand.

- **One type per row shape, in `src/db/types.ts`.** A post used to be spelled
  six ways — the `Post` interface, `PostForEdit`, `PostForDelete`, `PostOwner`,
  and anonymous inline types in three handlers — with none authoritative. The
  rule that keeps it that way: *a type describes exactly the columns its query
  selects*. `ConferenceSummary` (`id, name`) is deliberately a separate type
  from `Conference`; having the narrow type is what makes the wide lie
  unwritable.
- **All four `as unknown as` casts are gone**, replaced by D1's `.first<T>()` /
  `.all<T>()` generics. The clearest one: `getAllConferences()` was typed
  `Promise<Conference[]>` over a `SELECT id, name`, so five declared fields did
  not exist on the objects it returned and TypeScript was content.
- **`getPostWithConference()` replaced three near-identical
  `posts JOIN conferences` queries** with different column lists, in
  `handleComponentPost`, `handleEditPostForm`/`requireOwnedPost` and
  `handleReportForm`. `guards.ts` now holds no SQL at all, and `OwnedPost` is an
  alias of `PostDetail` rather than a fourth hand-written shape.
- **`searchPosts()` owns the dynamic WHERE builder.** It was 35 lines inline in
  `handleSearch` and the most bug-prone block in the codebase: SQL fragments
  pushed into one array, bindings into another, where a mis-paired push shifts
  every later `?` onto the wrong value and returns wrong rows rather than an
  error. Clauses are now `{ sql, bindings }` objects, so that class of bug is
  unwritable rather than merely tested for. `LIMIT` is the exported
  `SEARCH_LIMIT`, which the "(showing the first 50)" copy reads, so the sentence
  cannot disagree with the query.
- **`tagConference()` owns the curated-list validation** that was inline in
  `handleCreatePost`, and `reserveSlug()` owns slug generation and collision
  suffixing. The non-atomic create is *recorded, not fixed* — the reason D1's
  `batch()` cannot help is in the `src/db/conferences.ts` module doc.
- **Two deliberate widenings, both unobservable.** `/search` now also selects
  `posts.created_at` and `/my-posts` also selects `location_address`, so both
  share one honest `PostWithConference` type instead of two near-identical
  anonymous ones. Neither renderer uses the added field. Likewise the ownership
  and report-form queries now select the full `PostDetail`.
- **`test/db-access.test.ts`** holds the new invariants as greps: no
  `DB.prepare` / `DB.batch` / SQL outside `src/db/`, no `as unknown as` anywhere
  in `src/`, no row shape declared outside `types.ts`, and every read carrying a
  generic. `test/session-access.test.ts`'s defence-in-depth grep moved with the
  SQL to `src/db/posts.ts` and gained a companion asserting the handlers still
  pass `sessionUserId(user)` into it — the clause only defends anything if the
  value bound to it comes from the session.

**Verification.** A temporary parity harness ran every pre-refactor statement
(copied out of git HEAD) and its replacement against the same seeded D1 and
compared results — including all 540 combinations of the five `/search` filters.
All identical; the harness was then deleted rather than left to duplicate every
query forever. The permanent cover is `test/search.test.ts` (24 tests) and
`test/handlers.test.ts` (18). Both were checked against mutation: reversing the
binding order fails four combination tests, and making `escapeLike` a no-op
fails both wildcard tests.

---

## Refactor Task 6 — `api.ts` is split and deleted, 2026-08-12

`src/routes/api.ts` is gone. Its 804 lines are seven modules by concern, and no
file in `src/routes/` now exceeds 303 lines (it was 1,199 at review). This was
the last task in `docs/refactor/`, and it was worth deferring: Task 1 removed
the hand-built responses and Task 3 the SQL, so what was left to split was
*guard → repository call → response*, and the seams follow the `src/db/` modules
instead of being drawn wherever the line count happened to allow.

| Module | Lines | Holds |
|---|---|---|
| `posts.ts` | 303 | authoring: create, my-posts, edit, delete |
| `post-detail.ts` | 172 | reading: `/post/:id`, its fragment twin, `renderPostDetail` |
| `conferences.ts` | 146 | `/conference/:slug`, featured list, their render helpers |
| `components.ts` | 130 | five `/api/components/*` fragments |
| `search.ts` | 102 | `/search` |
| `messages.ts` | 85 | inquiry send |
| `subjects.ts` | 63 | `/subject/:slug` |

- **The seam inside "posts" is authoring versus reading.** The plan put
  `handlePostPage` in `posts.ts` and `handleComponentPost` in `components.ts`,
  but those two share `renderPostDetail()` — following the plan meant either a
  route-to-route import or a shared `render.ts`, both of which the task's own
  criteria ban. They live together in `post-detail.ts` instead, which keeps the
  renderer private and makes "delete the component route once browser caches
  expire" (see backlog) a one-file change. What is left in `posts.ts` all
  requires a session and acts on your own posts; everything in `post-detail.ts`
  renders for anonymous viewers too.
- **Render helpers stayed private to one module each.** No shared `render.ts`
  was created. A grab bag would have rebuilt `api.ts` a piece at a time, and the
  no-cross-import rule is what makes the pull toward one visible.
- **It is a pure move, and that was proven rather than assumed.** All 23
  top-level functions across the old `api.ts` and `posts.ts` are byte-identical
  in their new homes — checked by extracting and comparing each one — and
  `git diff src/routes.ts` touches only the import block, so the `ROUTES` array
  and therefore every path → handler binding is unchanged. A `wrangler dev`
  response diff was planned but skipped: with the handler bodies and the route
  table both proven identical, it could only have sampled what was already
  established.
- **`test/route-modules.test.ts`** holds the new invariants: no route module
  imports another, none exceeds a 320-line bound, and every exported `handle*`
  appears in `ROUTES`. Checked against mutation like the earlier guard tests — a
  sibling import, a padded file, and a deleted `ROUTES` row each fail it.
- **No behaviour changed**, deliberately or otherwise. This is the only task in
  the six with an empty "deliberate behaviour changes" list.

---

# Conference archiving and the 2026-09-03 copy round

A single feedback round from Eric Burkholder, tracked in `updates.md` at the
repo root. Most of it was copy; one item was a feature.

## Archiving finished conferences

**The ask:** once a conference's last day has passed, it and its posts should be
archived — the conference stops being selectable when creating a post, its posts
stop accepting inquiries, and its posts stop being editable.

**No column, and no sweep job.** The obvious implementation is
`conferences.is_archived` plus a cron that sets it, and it was rejected: the
answer is already in `conferences.stop_time`, and a stored flag is a second
answer that can disagree with the first. A flag would be wrong for every
conference between its last day and the next run of the sweep, and wrong forever
for any conference whose dates were later corrected. `src/lib/archive.ts` is the
whole feature: one comparison, asked wherever it matters, so every part of the
app archives a conference at the same instant.

**The grace day is load-bearing.** `stop_time` is midnight UTC *at the start of*
the last day — that is what `<input type="date">` submits and what
`createConference()` stores. Comparing `stop_time` against now directly would
archive a conference on the morning of its closing session, which is precisely
when someone is most likely to be looking for a ride back. `ARCHIVE_GRACE_SECONDS`
is 24 hours and `isArchivedStopTime()` is the only place the comparison is
written.

**What archiving does not do.** It hides nothing. `/conferences`, `/search`,
`/subject/:slug`, the homepage feed and `/my-posts` all still list finished
conferences and their posts, and `/conference/:slug` and `/post/:id` still
render. A post is a record of a trip that happened; a dead link is worse than a
clearly-labelled finished one, and the pages that would have had to be filtered
are exactly the ones a search engine has already indexed. `listConferences()` —
the create-post `<option>` list — is the one query that filters, because it is
the one place a conference is *chosen* rather than read.

**Delete survives archiving; edit does not.** This asymmetry is the design, not
an oversight. Archiving stops a stale offer being *presented* as a live one, and
an edit is how a post stays presented — so it closes with the conference.
Clearing away the post you left behind is the opposite of presenting it, so it
stays available forever. `requireEditablePost()` in `src/lib/guards.ts` is that
distinction made structural: the edit pair asks for it, the delete pair keeps the
plain `requireOwnedPost()`. Writing it as a guard rather than an `if` in each
handler is what stops the form and its submit drifting apart, which is the same
reason `requireOwnedPost()` exists.

**Every refusal is checked against the database, not the form.** The picker
omits finished conferences, but `handleCreatePost` re-reads the conference's
`stop_time` by id anyway (`getConferenceStopTime()`), because the id arrives in a
form body and a form body is never trusted — and because a conference can finish
between the page load and the submit, which a filtered `<option>` list cannot
cover. `handleMessageSend` checks the same way: `getPostAuthorContact()` was
widened to select `c.stop_time` on the same row the address comes from, so the
two facts cannot describe different posts. Creating a *new* conference that has
already finished is refused too — the row would be archived the instant it
existed, holding a slug nobody could ever post against.

**The pages drop the actions rather than offering and refusing them.** The post
page swaps the inquiry form for a closed notice, drops the author's Edit button
and keeps Delete; `/my-posts` shows "Archived" where Edit would be;
`/conference/:slug` states the notice and replaces "Post for this conference"
with a link to `/conferences`. Nothing on a rendered page points at a guard that
would 403.

**The test fixtures had to stop using literal dates.** Roughly a dozen fixture
conferences were seeded at `2026-03-01`, which was in the past by the time this
landed — so every one of them would have been archived and half the suite would
have failed for a reason unrelated to what it tests. `dateFromNow()`, `UPCOMING`
and `FINISHED` in `test/helpers/seed.ts` replace them. A fixture whose behaviour
depends on whether the conference is over now says so relative to now, rather
than passing until a date goes by and then failing mysteriously.
`test/archive.test.ts` (16 tests) covers the cutoff's boundary, all three
closures at the request level, the delete asymmetry, and what each page says.

## The curated-list renames — migration 0005

Two label changes, in one new migration file rather than as edits to 0002 and
0003, for the reason those files record: an applied migration never runs again.

- **`mathematics` → "Mathematics & Statistics".** Name only. The slug addresses
  `/subject/:slug` and every `conference_tags` row, and nothing about a display
  name requires moving it.
- **`airport-transfer` → `rideshare` / "Rideshare/Taxi".** Slug *and* name, using
  the same insert-repoint-delete sequence 0002 used for the subject slugs. The
  narrower option is that only the name had to change — but the slug is the
  address of `/search?share=`, and leaving `airport-transfer` as the address of a
  type called Rideshare/Taxi is exactly the drift this project has already paid
  for once. `UPDATE OR REPLACE` on `post_share_types` handles the one collision
  the rename can hit, a post somehow carrying both slugs.

Existing `?share=airport-transfer` links stop matching. That was accepted: the
filter returns an empty result rather than an error, and the alternative was a
permanent lie in the URL space.

## Copy changes

- **The create form's email is now displayed text**, not a readonly `<input>`,
  with a note that inquiries go there and that inquirers do not get the address
  until the author replies. Nothing ever read `email` off that form —
  `handleCreatePost` takes the address from the session — so the box was only
  ever inviting people to edit a field that does not exist. `.field-value` in
  `style.css` is the new class; the Eleventy placeholder matches its shape so the
  step does not reflow when HTMX swaps.
- **A pointer to How It Works** sits between the Description label and its box.
- **The featured-conference empty state** is now an invitation to write in rather
  than an apology, with the address from `getConfig().adminEmail`.
- **How It Works**: rideshare/taxi in the opening list; "Your field and
  institution" dropped from the what-to-include list; a gender-preferences bullet
  added; examples 1 and 2 rewritten to model stating a gender preference (or
  explicitly not having one).
- **About, Safety, Terms, Privacy**: every place that described the `.edu` gate as
  restricting *access* now says it gates account creation and account-based
  features, and states that public content is readable by anyone. That was the
  substance of the round — the old wording implied the site was closed to
  non-`.edu` readers, which it never has been.
