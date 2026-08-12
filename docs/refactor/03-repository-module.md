# Task 3 — Repository module

> ## ✅ Landed 2026-08-12
>
> `src/db/` holds every SQL statement: `types.ts`, `posts.ts`, `conferences.ts`,
> `tags.ts`, `users.ts`, `moderation.ts`. `routes/api.ts` went 1074 → 804 lines
> and `lib/guards.ts` now contains no SQL at all.
>
> All five acceptance criteria are met — see the checklist at the bottom. The
> interface below was implemented close to as proposed; the deviations, all
> deliberate, are recorded in **Deviations from the plan** at the end.
>
> Written up in CLAUDE.md under "Refactor Task 3". Task 6 is now unblocked.

**Size:** Large
**Depends on:** Tasks 1 (✅ landed 2026-08-10) and 2 (✅ landed 2026-08-11) — both
soft. With them landed first the diff is far more readable, but neither blocks.
**Risk:** Medium — this is the change most likely to alter behaviour silently.
Do it query by query, not as one sweep.

> **Re-measure before starting.** Task 1 rewrote response construction
> throughout `api.ts`, `posts.ts` and `flags.ts`, so every line number in this
> document has shifted and the call-site counts have moved: `DB.prepare()` is
> now **27**, not 30. The four `as unknown as` casts are now at `api.ts:50`,
> `:64`, `:79` and `:237`. The queries themselves were not touched.

**This is the highest-leverage task in the backlog and the one that unblocks
handler testing. Reserve it for whoever knows the data model best.**

---

## Problem

27 `DB.prepare()` call sites (30 at review) hold ~28 distinct SQL statements
inline in HTTP handlers. Three consequences follow.

### Row types are redeclared, not defined

A post's shape is spelled out six different ways: the `Post` interface,
`PostForEdit`, `PostForDelete`, `PostOwner`, plus anonymous inline types in
`handleComponentPost`, `handleMyPosts` and `handleSearch`. None is
authoritative.

Four `as unknown as` casts — now `api.ts:50`, `:64`, `:79`, `:237` — defeat the type
checker outright. The clearest example: `getAllConferences()` is typed
`Promise<Conference[]>`, but its query is `SELECT id, name FROM conferences`. The
returned objects are missing five declared fields, and TypeScript is perfectly
happy about it because the cast launders the type.

### The same query is written three times

Near-identical `SELECT posts JOIN conferences` appears in
`handleComponentPost`, `handleEditPostForm` and `handleReportForm`, each with a
slightly different column list. Three call sites, one query — a textbook depth
opportunity.

### Nothing is testable

Every handler reaches into `env.DB` with raw SQL, so exercising one requires a
real database. This is why there are zero handler tests despite
`@cloudflare/vitest-pool-workers` being configured and providing a real D1 in
process.

---

## Query inventory

The ~28 statements to relocate, so the assignee can work through them
systematically:

**`routes/api.ts`**
1. `getFeaturedConferences` — `conferences WHERE is_featured = 1 LIMIT 10`
2. `getConferenceBySlug`
3. `getPostsByConferenceId`
4. `getAllTags`
5. `getTagsForConference`
6. `getAllConferences` — `SELECT id, name` (the type lie, above)
7. `generateUniqueSlug` — `SELECT 1 FROM conferences WHERE slug = ?` in a loop
8. `INSERT INTO conferences ... RETURNING id`
9. `INSERT OR IGNORE INTO conference_tags` (batch)
10. `INSERT INTO posts ... RETURNING id`
11. `handleMessageSend` — `SELECT u.email, p.title FROM posts JOIN users`
12. `INSERT INTO message`
13. `handleComponentPost` — `SELECT p.*, c.name, c.slug JOIN conferences`
14. `handleMyPosts` — `SELECT posts JOIN conferences WHERE user_id`
15. `handleSearch` — dynamic `WHERE` builder (~35 lines)
16. `handleSubjectPage` — `SELECT slug, name FROM tags WHERE slug = ?`
17. `handleSubjectPage` — `conferences JOIN conference_tags LEFT JOIN posts GROUP BY`

**`routes/posts.ts`**
18. `SELECT p.*, c.name FROM posts JOIN conferences WHERE p.id` (edit form)
19. `SELECT id, user_id FROM posts WHERE id` (×2 — edit submit, delete submit)
20. `UPDATE posts SET title, description WHERE id AND user_id`
21. `SELECT id, title, user_id FROM posts WHERE id` (delete confirm)
22. `DELETE FROM flags WHERE post_id` + `DELETE FROM posts WHERE id AND user_id` (batch)

**`routes/flags.ts`**
23. `SELECT p.id, p.title, c.name JOIN conferences WHERE p.id`
24. `SELECT id, title FROM posts WHERE id`
25. `INSERT INTO flags`

**`routes/auth.ts`**
26. `SELECT * FROM users WHERE email`
27. `INSERT INTO users ... RETURNING id`
28. `UPDATE users SET last_login_at`

---

## Proposed interface

```ts
// src/db/posts.ts
export async function getPost(env: Env, id: number): Promise<Post | null>;
export async function getPostWithConference(env: Env, id: number): Promise<PostWithConference | null>;
export async function listPostsForUser(env: Env, userId: number): Promise<PostWithConference[]>;
export async function searchPosts(env: Env, filters: SearchFilters): Promise<PostWithConference[]>;
export async function createPost(env: Env, input: NewPost): Promise<number>;
export async function updatePost(env: Env, id: number, userId: number, fields: PostFields): Promise<void>;
export async function deletePostAndFlags(env: Env, id: number, userId: number): Promise<void>;

// src/db/conferences.ts
export async function getConferenceBySlug(env: Env, slug: string): Promise<Conference | null>;
export async function listConferences(env: Env): Promise<ConferenceSummary[]>;
export async function listFeaturedConferences(env: Env): Promise<Conference[]>;
export async function createConference(env: Env, input: NewConference): Promise<number>;
export async function reserveSlug(env: Env, name: string): Promise<string>;

// src/db/tags.ts
export async function listTags(env: Env): Promise<Tag[]>;
export async function listTagsForConference(env: Env, conferenceId: number): Promise<Tag[]>;
export async function tagConference(env: Env, conferenceId: number, slugs: string[]): Promise<void>;
export async function listConferencesForTag(env: Env, slug: string): Promise<ConferenceWithPostCount[]>;

// src/db/users.ts
export async function upsertUserOnLogin(env: Env, email: string, now: number): Promise<number>;

// src/db/moderation.ts
export async function recordFlag(env: Env, input: NewFlag): Promise<void>;
export async function recordMessage(env: Env, input: NewMessage): Promise<void>;
```

---

## Design notes for whoever picks this up

- **One type per shape, exported from `src/db/types.ts`.** `ConferenceSummary`
  being a distinct type from `Conference` is the whole point — it makes the
  `getAllConferences` lie impossible to write.

- **Delete every `as unknown as`.** Use D1's generic form (`.all<T>()`,
  `.first<T>()`), which the newer code in `posts.ts` and `flags.ts` already does
  correctly.

- **`searchPosts` takes a `SearchFilters` object and owns the dynamic WHERE
  builder**, including `escapeLike`. That builder is currently 35 lines inline in
  `handleSearch` and is the single most bug-prone block in the codebase — it
  concatenates SQL fragments and pushes bindings in parallel arrays, where an
  ordering mistake is silent.

- **`tagConference` owns the "only slugs already in `tags`" validation**,
  currently inline in `handleCreatePost`. That rule is the reason the curated tag
  list stays curated — it belongs with the write, not with an HTTP handler.

- **Record, do not fix, the non-atomic create.** `handleCreatePost` performs
  conference insert → tag batch → post insert as three separate writes. A failed
  post insert leaves an orphan conference that has burned its slug. D1's
  `batch()` cannot help, because the post insert needs the conference's
  `RETURNING id`. Put this in the `db/conferences.ts` module doc comment as a
  known limitation rather than pretending it is solved.

- **Two known production data issues are adjacent but out of scope.** Do not try
  to fix them here; see the Backlog section of `CLAUDE.md`:
  - Production `tags` rows use short slugs (`cs`, `bio`) while `db/schema.sql`
    seeds long ones (`computer-science`, `biology`).
  - Tags are only ever written in the "Create New Conference" branch, so
    conferences that predate the feature can never be tagged.

---

## Acceptance criteria

- [x] No `DB.prepare` anywhere outside `src/db/`. Enforced by
      `test/db-access.test.ts`, which also bans `DB.batch` and any bare SQL
      keyword outside those modules.
- [x] Zero `as unknown as` in `src/`. Also enforced there, along with "every read
      names its row type via a D1 generic" — the one exception being
      `reserveSlug()`'s `SELECT 1` existence probe, which discards the row.
- [x] Every row shape has exactly one type definition in `src/db/types.ts`. The
      grep for it looks for column-shaped field names inside any interface
      declared elsewhere in `src/`.
- [x] **At least four handler tests.** 42 of them: `test/search.test.ts` (24) and
      `test/handlers.test.ts` (18), covering `handleSearch`, `handleMyPosts`,
      `handleCreatePost`, `handleEditPostSubmit` and `handleDeletePostSubmit`.
      Written against the **real** in-process D1 rather than a fake — see
      Deviations.
- [x] Deletion test: `src/db/` is not a pass-through. Removing it would scatter
      the `/search` clause builder and `escapeLike`, slug generation and
      collision suffixing, the curated-tag validation, the flags-cascade rule on
      delete, the create-or-update branch on login, and one shared
      `posts JOIN conferences` back across the handlers — plus re-duplicate every
      row type. The thinnest modules are `users.ts` (one function, but it hides a
      branch) and `moderation.ts` (two inserts, grouped because both tables are
      write-only); both are noted as candidates to fold elsewhere if they do not
      grow.

---

## Deviations from the plan

- **Handler tests run against a real D1, not a fake `env.DB`.**
  `@cloudflare/vitest-pool-workers` provides one in process, and the risk this
  task actually carries is a *SQL* mistake — a binding on the wrong `?`, a filter
  that matches everything. A fake returns whatever rows the test hands it and so
  cannot fail on any of those. Both suites were mutation-checked to confirm they
  bite: reversing the binding order fails four combination tests, and making
  `escapeLike` a no-op fails both wildcard tests.

- **`SearchFilters` takes parsed timestamps, not date strings.** `overlapsFrom` /
  `overlapsUntil` rather than `start` / `end`, named for the comparison they
  make, since the query-parameter names read as the opposite of the columns they
  filter on. Parsing `<input type="date">` values stays in the handler, which
  also needs the raw strings to echo back into the form.

- **The clause builder returns `{ sql, bindings }` pairs.** The plan asked
  `searchPosts` to own the builder; keeping each fragment with its own bindings
  additionally makes the mis-pairing bug structurally impossible rather than
  merely relocated.

- **Two column lists were widened so one type could be honest.** `/search` also
  selects `posts.created_at` and `/my-posts` also selects `location_address`, so
  both share `PostWithConference`; the ownership and report-form queries now
  select the full `PostDetail`. Neither renderer reads the added fields, and a
  parity harness confirmed identical output.

- **`getAllTags` became `listTags` + `getTag`**, and `listPostsForConference` was
  added — neither was in the proposed interface, both are one query each that the
  conference and subject pages needed.

- **`OwnedPost` survives as an alias of `PostDetail`** rather than being deleted,
  so `requireOwnedPost()`'s signature and the Task 2 documentation around it
  still read correctly.

---

## Verification performed

Step 1 of the plan below called for capturing `wrangler dev` responses before the
change and re-checking against them. What was done instead is stronger and does
not depend on a hand-driven browser: a temporary parity harness ran **every**
pre-refactor statement (copied verbatim out of git HEAD) and its replacement
against the same seeded D1, comparing results row for row — including all **540**
combinations of the five `/search` filters, and the awkward values (`%`, `_`, an
unparseable date, a tag no conference carries). All identical.

The harness was deleted once green: keeping it would mean maintaining a second
copy of every query forever, which is the duplication this task removed. The
permanent replacement is `test/search.test.ts` and `test/handlers.test.ts`.

---

## Verification

This is the task where a silent behaviour change is most likely. Recommended
approach:

1. Before starting, capture responses from `wrangler dev` for a representative
   request set — `/`, `/search` with each filter combination, `/search` with no
   filters, `/my-posts`, `/conference/:slug`, `/subject/:slug`, `/post/:id`,
   `/post/:id/edit` — and save them.
2. Migrate **one query at a time**, re-running against the captured set.
3. Pay particular attention to `handleSearch`: the filter combinations
   (`q`, `conference`, `tag`, `start`, `end`, and every subset) are where a
   binding-order mistake will hide. Cover them in the new unit tests rather than
   only by hand.
4. `LIMIT 50` and the "(showing the first 50)" count behaviour must survive the
   move.
