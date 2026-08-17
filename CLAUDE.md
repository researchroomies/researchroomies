# ResearchRoomies – Agent Documentation

## Project Overview

ResearchRoomies is an academic conference travel cost–sharing platform. Academics post to find roommates, carpool partners, or other shared-expense arrangements for conferences.

**Stack:** Cloudflare Workers (TypeScript) + D1 (SQLite) + Eleventy (static pages) + HTMX

**Key files:**
- `src/index.ts` – Worker entry point: fetch handler, trailing-slash redirect, asset fallthrough. ~39 lines, no route list
- `src/routes.ts` – the `ROUTES` table + `createRouter()`; the single declaration of what the Worker owns
- `src/routes/` – one module per concern, none importing another:
  - `conferences.ts` – `/conference/:slug` + the featured-list fragment
  - `all-conferences.ts` – `/conferences`, grouped by subject
  - `subjects.ts` – `/subject/:slug`
  - `search.ts` – `/search`
  - `components.ts` – the `/api/components/*` HTMX fragments
  - `post-detail.ts` – reading a post: `/post/:id` and its fragment twin
  - `posts.ts` – authoring a post: create, edit, delete
  - `my-posts.ts` – `/my-posts`, the author's own listing
  - `messages.ts` – inquiry send
  - `auth.ts` – magic link login/logout/session
  - `flags.ts` – post reporting
- `src/db/` – every SQL statement, by table: `types` (every row shape), `posts`, `conferences`, `tags`, `share-types`, `users`, `moderation`
- `src/lib/` – `config` (all deployment literals), `response` (every HTML response), `guards` (every session and ownership check), `shell.mjs` (the page chrome), `auth` (HMAC tokens), `session`, `turnstile`, `html`, `params`, `router`, `mailgun`, `share-types` (the picker/badge/option markup)
- `templates/style/style.css` – the only stylesheet: Classical tokens, then the
  system's component classes, then the application layer. No framework, no build
  step. See the styling section of AGENTS.md before touching it.
- `templates/pages/` – Eleventy (Nunjucks) page templates
- `templates/layouts/base.njk` – **generated** from `shell.mjs`; do not edit
- `migrations/` – D1 migrations, applied in `NNNN_` order; **the only definition of the database**

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

## Current State — updated 2026-08-17

Eric Burkholder's first feedback round is fully implemented and the follow-up review of that work is closed out. **All six refactor tasks have landed** (see `docs/refactor/`, now closed).

Suite is **447 tests across 15 files** (373 across 12 at the close of the
refactor; share types, the all-conferences index and the redesign added the
rest), up from 21 across 3 before it. `npm run build` and `tsc --noEmit` are clean. `npm run check` runs all three in the right order — build first, because the guard tests read `public/`.

### Trailing-slash 404 on every Worker route — fixed 2026-08-10

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

### Feedback round 1 — all closed

| # | Item | Status |
|---|---|---|
| 1 | "My Posts" page | ✅ `GET /my-posts` |
| 2 | Search | ✅ Now actually reachable and filtering — see "Asset shadowing" below |
| 3 | Logout showed `{"ok":true}` | ✅ `HX-Redirect: /` |
| 4 | City/State instead of Location | ✅ stored as `"City, State"` in `location_address` |
| 5 | Duplicate-conference notice | ✅ plus real slug-collision handling |
| 6 | Pre-submit privacy disclaimer | ✅ |
| 7 | `.edu` email restriction | ⬜ **Still an open decision — see below** |
| 8 | About page bio rewrite | ✅ |
| 9 | Conference list indentation | ✅ |
| 10 | Conference name + location + dates | ✅ + subject tags |
| — | Edit/delete own posts | ✅ `src/routes/posts.ts` |

### Fixed in this round

- **Asset shadowing of `/search`.** `templates/pages/search.njk` built to `public/search/index.html`, and Cloudflare serves a matching asset *before* invoking the Worker, so `handleSearch` never ran. The template is deleted, `/search` is listed in `run_worker_first`, and search now filters on keywords (`q`), conference name, subject tag, and date range. `conference.njk` and `subject.njk` were deleted for the same reason — all three were Eleventy shells the Worker fully renders.
- **Route registration is no longer prefix-guessed.** `src/index.ts` used a hand-maintained `/^\/(api|conference|post)\//` regex to decide what was dynamic. It now asks `router.match()`, so a registered route can never be stranded behind a stale regex again.
- **Turnstile was inert.** The client script only loaded on `/login`, so create-post and inquiry forms never produced a token — and both handlers used `if (token) { verify }`, silently skipping the check. The script went into both page shells (one shell since Task 4), and `verifyTurnstile()` in `src/lib/turnstile.ts` treats a missing token as failure.
- **Stored XSS.** Post titles, descriptions, conference names, locations, and page titles were interpolated raw. Everything now goes through `escapeHtml()` from `src/lib/html.ts`.
- **Nav login state on Worker-rendered pages.** `renderFullPage()` was a drifted copy of `base.njk` missing `#nav-user-state`. Both now render the same nav, with user state and subject links as HTMX fragments.
- **Conference slug collisions.** `generateUniqueSlug()` suffixes duplicates (`-2`, `-3`), backed by a `UNIQUE` index.
- **Dead surface built out.** Subject tags (curated seed list, conference-level, browsable at `/subject/:slug`), post reporting into `flags` with an admin email, and inquiry persistence into `message`.
- **Deploy safety.** `npm run deploy` is now `npm run build && wrangler deploy`; it previously shipped whatever stale HTML was in `public/`.

---

### Round 2 — hardening pass, 2026-08-10

- **HTML injection into inquiry emails.** `sendInquiryEmail` interpolated `postTitle` and `messageContent` raw into the HTML body a third party receives. Now escaped via `escapeHtmlForEmail()`, as `sendReportEmail` already was.
- **D1 error text leaked to clients.** `handleCreatePost` returned `"Internal Server Error: " + err.message`, which surfaced constraint and table names. Generic 500 now; details stay in `console.error`.
- **`handleAuthCallback` had no try/catch.** A `throw` mid-login escaped the handler and became the runtime's bare 500 with no page — from a link clicked in an email. Wrapped, and its failure responses are now rendered pages pointing back at `/login`.
- **`handleSubjectPage`'s tag lookup sat outside its own try block**, so a D1 failure there was an unhandled 500 while the identical failure one query later rendered an error page.
- **`handleReportForm` was a post-existence oracle.** It queried the post *before* checking the session, so an anonymous caller got 302 for a real post id and 404 for a missing one. Session check now comes first, matching every other handler.
- **`parseInt()` id validation was ineffective everywhere.** `parseInt("12abc", 10)` is `12` and `Number.isFinite()` accepts it, so malformed URLs resolved to unrelated rows. `parseRouteId()` in `src/lib/params.ts` requires all digits; `api.ts`, `posts.ts` (`parsePostId`) and `flags.ts` all route through it. Covered by `test/params.test.ts`.
- **`/post/:id` is server-rendered.** It was the last page on the static-shell pattern: `post.njk` shipped "Loading post details…" plus inline JS that re-parsed the id out of `window.location` to fetch `/api/components/post/:id` — three round trips, and crawlers and link unfurlers never saw a title or description for the site's primary entity. `handlePostPage` now renders directly, with `<meta name="description">` and OpenGraph tags. `templates/pages/post.njk` is deleted. `/api/components/post/:id` is retained deliberately so old shells still in browser caches degrade to a working page.
- **`renderFullPage()` takes an options object** (`description`, `canonicalUrl`) — the equivalent of `base.njk`'s `{% block head %}`. It still owns the title suffix, so callers pass a bare title.

---

### Refactor Task 1 — response module + route-ownership guards, 2026-08-10

Two invariants that used to live in prose are now tests, and HTML responses have one construction path.

- **`src/lib/response.ts` is the only place an HTML response is built.** `pageResponse` / `fragmentResponse` / `htmlResponse`, plus `notFoundPage()` / `forbiddenPage()` / `errorPage()`, which used to be private to `posts.ts` while `api.ts` and `flags.ts` hand-rolled their own. `charset=utf-8` is written once (it was 29 sites saying `text/html` and 12 saying `text/html; charset=utf-8`). Cache policy is a closed union — `'public-short'` / `'public-long'` / `'private'` / `'none'` — **defaulting to `'private'`**, so caching a session-varying fragment publicly takes a deliberate act.
- **`errorPage()` takes no argument.** Round 2 fixed a handler that returned `"Internal Server Error: " + err.message` and leaked D1 constraint and table names; there is now no parameter to put them in.
- **The route table moved to `src/routes.ts`.** `src/index.ts` went 93 → 39 lines and holds only the fetch handler, the trailing-slash 308, and the asset fallthrough. `ROUTES` is importable, which is what makes the guard tests possible.
- **`test/assets.test.ts` guards asset shadowing and `run_worker_first`.** It reads `ROUTES` directly, so a new route is checked automatically. It failed on first run for six routes — `/conference/*`, `/subject/*` and `/post/*` were missing from `wrangler.toml` and have been added. Its wildcard matching mirrors Cloudflare's own asset rules engine (`*` crosses `/`, so `/post/*` covers `/post/1/edit`) rather than guessing.
- **Two vitest projects now.** The guard tests need `node:fs` to read `public/` and `wrangler.toml`, which workerd does not have. `vitest.config.mts` declares a `workers` project and a `node` project; plain `npx vitest run` runs both — do not narrow it. They fail loudly rather than skipping when `public/` is absent.
- **Deliberate behaviour changes:** fragments gained `charset=utf-8`; responses that previously sent no `Cache-Control` now send `no-store` (404/500 pages and error fragments only); per-handler 404/500 copy collapsed into the generic shared text.

---

### Refactor Task 5 — configuration module, 2026-08-10

`src/lib/config.ts` is now the only place a deployment literal lives. `getConfig(env, request?)` returns `origin`, `sessionTtlSeconds`, `magicLinkTtlSeconds`, `turnstileSiteKey`, `mailgun` and `adminEmail`. Every default reproduces the literal it replaced, so an existing deployment that sets none of the new vars is unaffected.

- **The session TTL had two definitions** — `lib/auth.ts` set the token's `exp`, `routes/auth.ts` set the cookie's `Max-Age`, and they agreed by coincidence. Divergence is a silent logout. One constant now, and `handleAuthCallback` derives both from a single local. Verified end-to-end, not just by reading: `exp - iat` = 2592000 = the cookie's `Max-Age`.
- **The origin is derived from the request** (`APP_ORIGIN` overrides), so a staging deployment links to itself instead of to production. Note the `wrangler dev` caveat in the backlog.
- **The Turnstile sitekey has one definition**, `TURNSTILE_SITE_KEY` in `[vars]`. Worker forms call `turnstileWidget(env)`; Eleventy pages use a `{{ turnstileSiteKey }}` global that `eleventy.config.js` reads back out of `wrangler.toml`, failing the build if it is missing. `TURNSTILE_SECRET_KEY` stays a secret.
- **`MAILGUN_SENDING_KEY` was documented, not renamed.** It is a From address, not a key, but renaming it means rotating a deployed secret by hand for no functional gain. `config.mailgun.from` carries the correct meaning; the var keeps the wrong name.
- **The "valid for 15 minutes" copy is generated** from `MAGIC_LINK_TTL_SECONDS`, in both email bodies and the expired-link page, so it cannot drift from the token.

---

### Refactor task 4 — the two page shells are now one, 2026-08-10

`renderFullPage()` and `base.njk` were hand-maintained copies of the same chrome, kept together by a paragraph in this file. The chrome now lives once, in **`renderShell()` (`src/lib/shell.mjs`)** — plain ESM so the Worker bundle, the build script and the test suite can all load it. `renderFullPage()` is a thin call into it (unchanged signature), and `scripts/gen-layout.mjs` generates `templates/layouts/base.njk` from it ahead of Eleventy in `npm run build`.

`base.njk` is committed with a `{# GENERATED FILE #}` banner rather than gitignored, so `npx vitest run` works on a fresh clone. `test/shell.test.ts` reads the committed layout, substitutes the same Nunjucks markers the generator emitted, and asserts the result is byte-identical to `renderFullPage()` — head, footer, and whole document. A hand-edited or stale layout fails the suite.

Three live bugs closed with it:

- **Blank copyright year on every built page.** `base.njk` rendered `{{ year }}` with nothing defining it, so static pages shipped `© ResearchRoomies` while Worker pages showed the year. `eleventy.config.js` now supplies `year` (and `siteOrigin`) as global data.
- **No meta on static pages.** About, Terms, Privacy, Safety, How It Works, Login, Create, Home and 404 had no description, no OpenGraph tags and no canonical link — they produced no link preview at all. Each page now carries `title` and `description` front matter; the shell builds the tags, and canonical/`og:url` come from `siteOrigin` + `page.url`.
- **Two title contracts.** The nine `.njk` pages each wrote their own full title, seven with a hyphen and two with an en dash, while `renderFullPage()` appended ` – ResearchRoomies` itself. Pages now supply a bare `title` in front matter and the shell appends the suffix, one way, everywhere.

---

### Refactor Task 2 — auth and ownership guards, 2026-08-11

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

### Refactor Task 3 — repository module, 2026-08-12

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

### Refactor Task 6 — `api.ts` is split and deleted, 2026-08-12

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

## Open decisions

### `.edu` email restriction — built as a switch, currently OFF

The gate is implemented and off by default, so this is now a config decision rather than a code change.

**To enable:** set `RESTRICT_EDU_EMAILS = "true"` in `[vars]` in `wrangler.toml`, then `npm run deploy`. To disable, set it back to `"false"`. Enforced in `isEmailAllowed()` (`src/lib/auth.ts`), applied at both `/api/auth/start` and `/api/auth/callback` so toggling takes effect immediately rather than after in-flight magic links expire. Rejections return 403 with a message pointing people at `admin@researchroomies.com`.

**Know before enabling:**
- It is a strict `.edu` suffix match, so it rejects `.ac.uk`, `.edu.au`, and universities with no `.edu` domain — most non-US academics.
- **It applies to existing users, not just new signups.** Anyone already registered with a non-`.edu` address loses the ability to log in. If that matters, grandfather existing users by checking the `users` table before rejecting.

**Recommendation (unchanged):** leave it off. The magic link already proves inbox control and Turnstile now actually runs on every form, so the marginal spam benefit is small next to the exclusion cost. Flip it on if real spam shows up.

---

## Backlog

- **Handler-level error handling is the one structural theme the refactor left alone.** `src/` still has 24 `try {` blocks, roughly one per handler, each catching its own D1 failure and returning `errorPage()` or a fragment. Task 1 standardised what a failure renders and Task 2 removed the auth branches, but nothing collapsed the repetition itself. It was never in scope for any of the six tasks; noting it so the next reader knows it is a gap rather than an oversight.
- **The custom 404 page is probably never served.** `not_found_handling = "404-page"` looks for `public/404.html`, but Eleventy emits `public/404/index.html`. Found while verifying Task 4; not yet confirmed against production.
- **Worker pages are inconsistent about `description` / `canonicalUrl`.** `renderShell()` omits the meta and canonical tags when a handler passes nothing, which is the case for `/search`, `/my-posts` and the edit/delete/report pages. Task 4 fixed the shell and the nine static pages; this is the remaining half, and it is per-handler content rather than shell shape.
- **`test/assets.test.ts` imports `node:fs` with no `@types/node` installed**, so editors show a squiggle on the import. Harmless — `tsconfig.json` excludes `test/` and vitest does not typecheck — but `npm i -D @types/node` clears it.
- **`www.researchroomies.com` returns 522 for every path.** Only the apex is bound: `[[routes]]` in `wrangler.toml` has `pattern = "researchroomies.com"` with no `www` record or redirect. Found while diagnosing the search report; unrelated to search, but any inbound `www` link is currently dead.
- **Subject filtering matches nothing on production.** `/search?tag=cs` returns 0 of 4 posts. Tags are only ever written in the "Create New Conference" branch of `handleCreatePost`, so conferences that predate the feature — or that were reused rather than created — can never be tagged, and there is no UI to tag one afterwards. Needs conference editing (below) to be fixable by users. **`/conferences` now makes the size of this visible** — everything untaggable lands in its trailing "No subject yet" group, so that group's length is a direct read on how much of the table the subject filters cannot see.
- **The homepage's two lists are still HTMX-loaded**, and the redesign added a second one. `templates/pages/index.njk` fetches `/api/featured-conferences` and `/api/components/recent-posts` on load, so crawlers see the homepage copy but neither the conference links nor the post links. The redesign deliberately did not fix this — it is a rendering-model change, not a styling one — but it did raise the stakes: the feed is now the larger half of the page. `/conferences` is in the nav and fully server-rendered, so every conference is still reachable without JS; the post links are the remaining gap. Fixing it means server-rendering `/` (it is currently a static asset) or accepting it.
- **`/api/components/post/:id` has no caller.** `templates/pages/post.njk` was its only consumer and is deleted; `/post/:id` is server-rendered. The route is kept registered on purpose so an old shell still cached in a browser degrades to a working page instead of a dead `hx-get`. It shares `renderPostDetail()` with `handlePostPage` and now sits in the same file (`src/routes/post-detail.ts`), so it costs nothing to keep in sync. Safe to delete once the cache window has passed — assets are served with Cloudflare's defaults and the HTML shell is long gone from `public/`, so a few weeks is generous. Deleting it means removing the handler from `post-detail.ts`, its entry in `ROUTES` (`src/routes.ts`), and the row in the AGENTS.md route table. `test/assets.test.ts` and `test/route-modules.test.ts` both read `ROUTES`, so nothing else needs updating — but remove it from *both* places or the latter fails on a handler exported and never registered.
- **Post creation is not atomic (known limit).** Creating a post against a *new* conference is three separate writes: conference insert, tag batch, post insert. If the post insert fails, the conference survives as an orphan and holds its slug, so the user's retry gets `-2` appended to it. `batch()` cannot fix this — the post insert needs the id the conference insert `RETURNING`s, and `batch()` has no way to pipe one statement's output into the next. A real fix needs either a different API shape or a periodic sweep of conferences with zero posts. Recorded in the `src/db/conferences.ts` module doc, with a pointer from the `conferenceId === "new"` branch in `handleCreatePost`.
- **Moderation review.** `flags` rows are written and emailed to `admin@researchroomies.com`, but there is no in-app review UI. That needs an admin concept (`users.is_admin` or similar), which the schema does not have.
- **Structured locations.** `countries` / `states` / `cities` and `conferences.city_id` remain intentionally dormant; city/state are free text. Revisit if location-based search is wanted.
- **Editing conference details.** Posts are editable; the conference a post belongs to is not.
- **`message` is write-only.** Rows are recorded but never surfaced anywhere.
- **Inquiry persistence depends on email success.** `handleMessageSend` inserts the `message` row only after Mailgun accepts, so a Mailgun outage returns 500 and records nothing. Deliberate for now (the row means "this was actually sent"), but worth revisiting.
- **Zero-config localhost magic links are still one flag away.** `getConfig()` derives the origin from the request, but `wrangler dev` synthesizes the request host from `[[routes]]`, so plain `npm run dev` still produces `http://researchroomies.com/...` links. Pinning it needs `--local-upstream localhost:<port>` or `--var APP_ORIGIN:...` (see AGENTS.md). A committed fix would have to hardcode a dev port, which is wrong the moment anyone passes `--port`; left as a documented flag instead.
- **npm audit reports 6 high advisories**, all dev-only (`wrangler`/`miniflare` → `sharp`, `ws`, `undici`); nothing reaches the edge, since Workers bundles only `src/`. There is currently no clean path to zero: `@cloudflare/vitest-pool-workers` ≥ 0.16.8 requires vitest 4, and 0.20.x drops the `./config` export `vitest.config.mts` imports, so upgrading needs a config migration. npm's own suggested "fix" is a downgrade into differently-vulnerable versions. Re-check when Cloudflare ships a clean combination.

---

## Architecture Notes

- **Asset routing precedence (the big footgun).** Cloudflare serves a matching static asset *before* invoking the Worker. Adding `templates/pages/foo.njk` will silently shadow a `GET /foo` Worker route — this is exactly how `/search` broke. Either don't create the template, or add the path to `run_worker_first` in `wrangler.toml`.
- **Trailing slashes.** Worker routes are slashless and `Router.match()` is `$`-anchored. `src/index.ts` redirects `/foo/` → `/foo` with a 308, but *only* when the trimmed path is a registered route — Eleventy assets are genuinely directory-style, so `/about/` must keep falling through to `env.ASSETS.fetch()`. Register new routes without a trailing slash and this keeps working.
- **Static vs. dynamic rendering:** pages in `templates/pages/` are built by Eleventy at deploy time; dynamic content is Worker-rendered or injected via HTMX. No page is on the static-shell-plus-fetch pattern any more; don't add one back. If a page has content worth indexing or link-previewing, render it in the Worker.
- **One page shell: `renderShell()` in `src/lib/shell.mjs`.** It is the only definition of the doctype, `<head>`, nav and footer. `renderFullPage()` calls it for Worker pages; `scripts/gen-layout.mjs` calls it during `npm run build` to *generate* `templates/layouts/base.njk` for Eleventy. Edit the chrome there and nowhere else — `base.njk` carries a `{# GENERATED FILE #}` banner and `test/shell.test.ts` renders both sides and diffs them byte for byte, so a hand-edited layout or a stale committed one fails the suite instead of drifting quietly.
- **One response path: `src/lib/response.ts`.** Never hand-build `new Response(html, { headers })`. `pageResponse()` for Worker pages, `fragmentResponse()` for `/api/components/*`, and `notFoundPage()` / `forbiddenPage()` / `errorPage()` for failures. `opts.cache` is a closed union defaulting to `'private'`; `errorPage()` takes no argument so an exception message cannot reach the client. Bare-text 4xx/405s, redirects and the two JSON endpoints in `auth.ts` are still plain `new Response` on purpose — converting them would change the wire format, and their shapes are Task 2's subject.
- **Routes live in `src/routes.ts`, not `index.ts`.** Add a `{ method, path, handler }` entry to `ROUTES`, without a trailing slash, and add a covering pattern to `run_worker_first` in `wrangler.toml`. `test/assets.test.ts` reads `ROUTES` and fails if you forget either.
- **The database is defined by `migrations/`, and old migrations are immutable.**
  Adding a subject, renaming a share type, or changing any table means a new
  numbered file — never an edit to one already applied, because an applied
  migration will not run again and the edit reaches new databases only. That is
  precisely how production ended up on five subject slugs while git described
  twelve. `test/helpers/seed.ts` applies the chain, so the suite fails on a
  migration that does not produce a working schema.
- **Share types are post-level and curated.** `src/db/share-types.ts` owns the
  SQL, `src/lib/share-types.ts` owns the picker/badge/option markup that four
  callers share. The write replaces rather than adds — see the section above for
  why that is not an arbitrary difference from `tagConference()`. Any new list
  page that renders badges should use `listShareTypesForPosts()` (one query per
  page), not `listShareTypesForPost()` in a loop.
- **One route module per concern, and none imports another.** The handler goes in the `src/routes/` module that owns its concern; if two modules need the same thing it belongs in `src/lib/` or `src/db/`, never in a sibling and never in a shared `render.ts` — that grab bag is how `api.ts` reached 1,199 lines. Render helpers stay private to the module that uses them, which is why `/post/:id` and `/api/components/post/:id` share `post-detail.ts` rather than splitting across `posts.ts` and `components.ts`. `test/route-modules.test.ts` fails the build on a cross-module import, on a module over 320 lines, or on a handler exported but not registered.
- **Deployment literals live in `src/lib/config.ts`.** `getConfig(env, request?)` is the only place an origin, TTL, sitekey, Mailgun setting or admin address is defined. The session TTL in particular has exactly one definition feeding both the cookie `Max-Age` and the token `exp` — they were two independent constants agreeing by coincidence, and divergence is a silent logout.
- **One data path: `src/db/`.** Handlers never touch `env.DB`; they call a named function from the module that owns the table, and every row shape is defined once in `src/db/types.ts`. `test/db-access.test.ts` fails the build on a `DB.prepare` outside `src/db/`, on any `as unknown as` in `src/`, or on a row shape declared next to a query. Type reads with D1's `.first<T>()` / `.all<T>()` generics — the casts they replace are what let `getAllConferences()` claim to return full conferences from a `SELECT id, name`.
- **Route ids:** parse with `parseRouteId()` from `src/lib/params.ts`, never bare `parseInt()`. `parseInt("12abc", 10)` is `12` and passes `Number.isFinite()`, which silently turns a malformed URL into a lookup of a different row.
- **Handler order:** check the session *before* querying anything keyed on a user-supplied id. Querying first leaks row existence through the status code to callers who are not allowed to see it. The guards do this by construction.
- **HTMX pattern:** `/api/components/*` return raw HTML fragments, not JSON.
- **Session auth: one entry point, `src/lib/guards.ts`.** Cookie-based signed tokens, no DB lookup per request. `requireUser(request, env, mode)` for anything that needs a user, `optionalUser()` where anonymous is fine, `requireOwnedPost()` for the post edit/delete family. Never call `getSessionUser()` from a handler — `test/session-access.test.ts` fails the build if you do. The three failure modes (`'page'` 302, `'api'` 401, `'htmx'` 200 + `HX-Redirect`) are documented on the `GuardMode` type and nowhere else; that folklore living in ten handlers instead is what the task fixed. Never trust an id from a form body — `requireOwnedPost()` re-checks ownership against the DB row.
- **Escaping:** Worker HTML is string-concatenated. Every interpolated DB or user value must pass through `escapeHtml()`.
- **Turnstile:** always verify with `verifyTurnstile()`; a missing token is a failure, never a skip.
- **Database:** D1 (SQLite), reached only through `src/db/` (above). Inside those modules: `env.DB.prepare(...).bind(...).first<T>()` / `.all<T>()` / `.run()` / `.batch([...])`, always `.bind()`, never string interpolation. Timestamps are Unix epoch seconds.
- **Local dev on Guix System:** `workerd` is a prebuilt ELF needing `/lib64/ld-linux-x86-64.so.2`, which does not exist on Guix. Anything that spawns it (`wrangler dev`, `wrangler d1 execute --local`, `vitest`) must run inside an FHS container — see the Testing section of `AGENTS.md`.
- **Never point local dev at real Mailgun.** `.dev.vars` holds a live key, and the login and report flows send to third parties. Stub it with `--var MAILGUN_API_BASE:http://127.0.0.1:8899/v3` and capture the multipart body locally; pair with Cloudflare's always-passing Turnstile test secret so forms submit without a browser. CLI `--var` overrides `.dev.vars`.
