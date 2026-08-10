# Task 3 — Repository module

**Size:** Large
**Depends on:** Tasks 1 and 2 (soft — they land first the diff is far more
readable, but neither blocks)
**Risk:** Medium — this is the change most likely to alter behaviour silently.
Do it query by query, not as one sweep.

**This is the highest-leverage task in the backlog and the one that unblocks
handler testing. Reserve it for whoever knows the data model best.**

---

## Problem

30 `DB.prepare()` call sites hold ~28 distinct SQL statements inline in HTTP
handlers. Three consequences follow.

### Row types are redeclared, not defined

A post's shape is spelled out six different ways: the `Post` interface,
`PostForEdit`, `PostForDelete`, `PostOwner`, plus anonymous inline types in
`handleComponentPost`, `handleMyPosts` and `handleSearch`. None is
authoritative.

Four `as unknown as` casts — `api.ts:45`, `:59`, `:74`, `:267` — defeat the type
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

- [ ] No `DB.prepare` anywhere outside `src/db/`.
- [ ] Zero `as unknown as` in `src/`.
- [ ] Every row shape has exactly one type definition in `src/db/types.ts`.
- [ ] **At least four handler tests** written against a fake `env.DB`. Suggested:
      `handleSearch`, `handleMyPosts`, `handleCreatePost`,
      `handleEditPostSubmit`. **These are the payoff** — without them the task
      delivered file movement rather than depth, and should not be considered
      done.
- [ ] Deletion test as a sanity check: if removing `src/db/` would *not* scatter
      complexity back across 11 handlers, the split is too thin and the modules
      are pass-throughs.

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
