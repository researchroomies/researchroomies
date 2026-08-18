# AGENTS.md – ResearchRoomies

Everything an AI agent needs to know before touching this codebase.

---

## What this project is

ResearchRoomies is a web platform where academics post to find conference travel cost-sharing partners (shared hotel rooms, rental cars, etc.). Users log in via magic-link email, create posts attached to conferences, and contact post authors via an in-site inquiry form.

Live site: `https://researchroomies.com`

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript, no Node.js APIs) |
| Database | Cloudflare D1 (SQLite dialect) |
| Static site builder | Eleventy 3 (Nunjucks templates) |
| Frontend interactivity | HTMX 2 + vanilla JS |
| Auth | Custom magic-link + HMAC-SHA256 session tokens (no third-party auth) |
| CAPTCHA | Cloudflare Turnstile |
| Email | Mailgun REST API |
| Deployment | `wrangler deploy` (Cloudflare Workers + D1) |

---

## Directory structure

```
researchroomies/
├── src/
│   ├── index.ts              # Worker entry point – fetch handler, trailing-slash
│   │                         #   redirect, static asset fallback
│   ├── routes.ts             # ROUTES table + createRouter() – the single
│   │                         #   declaration of what the Worker owns
│   ├── routes/               # One module per concern; none imports another
│   │   ├── conferences.ts    # /conference/:slug + the featured-list fragment
│   │   ├── all-conferences.ts # /conferences, grouped by subject
│   │   ├── subjects.ts       # /subject/:slug
│   │   ├── search.ts         # /search
│   │   ├── components.ts     # /api/components/* HTMX fragments
│   │   ├── post-detail.ts    # Reading a post: /post/:id + its fragment twin
│   │   ├── create-post.ts    # Writing a post: POST /api/post
│   │   ├── posts.ts          # Changing your own post: edit, delete
│   │   ├── my-posts.ts       # /my-posts, the author's own listing
│   │   ├── messages.ts       # Inquiry send
│   │   ├── auth.ts           # Magic link login/logout/session
│   │   └── flags.ts          # Post reporting
│   ├── db/                   # THE only place SQL lives
│   │   ├── types.ts          # Every row shape, defined exactly once
│   │   ├── posts.ts          # Post reads/writes + the /search filter builder
│   │   ├── conferences.ts    # Conference reads/writes + slug reservation
│   │   ├── tags.ts           # Subjects; tagConference() enforces the curated list
│   │   ├── positions.ts      # Academic positions; resolvePosition() rejects rather than drops
│   │   ├── users.ts          # upsertUserOnLogin()
│   │   └── moderation.ts     # flags + message (both write-only)
│   └── lib/
│       ├── config.ts         # getConfig() – origin, TTLs, sitekey, Mailgun, admin email
│       ├── auth.ts           # Token generation/verification (HMAC-SHA256), .edu gate
│       ├── session.ts        # getSessionUser() / sessionUserId() – cookie → payload
│       ├── guards.ts         # requireUser() / optionalUser() / requireOwnedPost()
│       │                     #   THE way a handler asks for a session
│       ├── shell.mjs         # renderShell() – THE page chrome; generates base.njk
│       ├── html.ts           # date formatting, renderFullPage, summarize, escapeHtml re-export
│       ├── response.ts       # htmlResponse/pageResponse/fragmentResponse +
│       │                     #   notFoundPage/forbiddenPage/errorPage
│       ├── params.ts         # parseRouteId() – strict numeric route ids
│       ├── turnstile.ts      # verifyTurnstile()
│       ├── mailgun.ts        # Email sending (magic link, inquiry, abuse report)
│       └── router.ts         # Custom path-param router
├── scripts/
│   └── gen-layout.mjs        # Writes templates/layouts/base.njk from shell.mjs
├── templates/
│   ├── pages/                # Eleventy source pages (Nunjucks .njk)
│   ├── style/style.css       # Source CSS – copied to public/style/
│   └── layouts/
│       └── base.njk          # GENERATED from src/lib/shell.mjs – do not edit
├── public/                   # Eleventy output – DO NOT EDIT DIRECTLY (gitignored)
├── migrations/               # D1 migrations (SQLite), applied in NNNN_ order
├── test/
│   ├── auth_verification.test.ts   # Magic link + session token crypto
│   ├── routing.test.ts             # Router matching + trailing slashes
│   ├── shell.test.ts               # Static layout vs. renderFullPage(), byte for byte
│   ├── params.test.ts              # parseRouteId()
│   ├── config.test.ts              # getConfig() defaults, origin derivation, TTL agreement
│   ├── guards.test.ts              # requireUser() × 3 modes × every anonymous case
│   ├── search.test.ts              # /search filter matrix against a real D1
│   ├── handlers.test.ts            # create/edit/delete/my-posts against a real D1
│   ├── helpers/seed.ts             # Schema + fixtures for the handler tests
│   ├── assets.test.ts              # Route-ownership guards (runs in node, not workerd)
│   ├── session-access.test.ts      # getSessionUser/ownership/siteverify greps (node)
│   ├── db-access.test.ts           # SQL-stays-in-src/db + no-cast greps (node)
│   └── route-modules.test.ts       # No cross-route imports, size bound, every
│                                   #   exported handler registered (node)
├── wrangler.toml             # Cloudflare config (D1 binding, routes, assets)
├── vitest.config.mts         # Vitest + @cloudflare/vitest-pool-workers
├── eleventy.config.js        # Eleventy config
├── package.json
├── CLAUDE.md                 # Current state, open decisions, backlog
└── AGENTS.md                 # This file
```

---

## Rendering architecture (critical to understand)

There are **three distinct rendering modes** in this app. Confusing them is the most common source of errors.

### 1. Static Eleventy pages (served as assets)

Pages in `templates/pages/` are compiled by Eleventy into `public/` at build time. They are plain HTML files served by Cloudflare via `env.ASSETS.fetch()`. They do not have access to the database or session state at render time.

These are all of them: `/` (index), `/login`, `/create`, `/about`, `/how-it-works`, `/terms`, `/privacy`, `/safety`, `/404`.

**The Worker decides ownership by asking `router.match()`**, not by path prefix. There is no prefix regex — the old hand-maintained `/^\/(api|conference|post)\//` was deleted precisely because forgetting to add a prefix to it stranded `/my-posts` and `/search` behind a silent 404. Anything the router does not claim falls through to `public/`.

When you edit a `.njk` template, you must run `npm run build` (Eleventy) before deploying. The Worker serves the pre-built `public/` files — it does not compile templates at runtime.

### 2. Worker-rendered full pages

`/conferences`, `/conference/:slug`, `/subject/:slug`, `/post/:id`, `/my-posts`, `/search`, and the post edit/delete/report pages are rendered server-side by the Worker using `renderFullPage()` from `src/lib/html.ts`. It is a thin wrapper over `renderShell()` in `src/lib/shell.mjs` — the same function that generates `base.njk` — so Worker pages and Eleventy pages get the same chrome by construction, `#nav-user-state` and `#nav-subjects` HTMX spans included.

Signature:

```typescript
renderFullPage(title, content, options?: { description?, canonicalUrl? })
```

`title` is bare — the function appends ` – ResearchRoomies` and escapes it. `options` is the equivalent of `base.njk`'s `{% block head %}`: `description` fills `<meta name="description">` plus the OpenGraph tags, `canonicalUrl` fills `og:url` and `<link rel="canonical">`. Set them on any page with real indexable content; `summarize(text, maxLength)` in the same module collapses whitespace and truncates on a word boundary for that purpose.

When you add a new Worker-rendered page, return it through `pageResponse()` (`src/lib/response.ts`) and register it in `src/routes.ts`.

**Do not build a static shell that fetches its own content.** `/post/:id` used to ship "Loading post details…" plus inline JS that re-parsed the id out of `window.location` to call `/api/components/post/:id` — three round trips, and crawlers and link unfurlers got no title or description for the site's primary entity. No page is on that pattern any more.

### 3. HTMX component fragments

Routes under `/api/components/*` return raw HTML fragments (no `<!DOCTYPE>` wrapper). HTMX swaps these into the DOM. Examples:

- `GET /api/components/nav-user` → login/logout link, swapped into `#nav-user-state`
- `GET /api/components/nav-subjects` → subject links for the nav
- `GET /api/components/create-form-auth` → email field for create form (or redirect if unauthenticated)
- `GET /api/components/conference-options` → `<option>` list for conference dropdown
- `GET /api/components/tag-options` → `<option>` list for subject filters and the create-post picker
- `GET /api/components/share-type-options` → the share-type checkboxes for the create-post form
- `GET /api/components/position-fields` → the position dropdown and institution box for the create-post form. Unlike the share-type fragment, a failure here renders a visible notice rather than nothing: both fields are required, so a form without them cannot be submitted at all
- `GET /api/components/recent-posts` → the homepage feed: the newest posts across every conference
- `GET /api/components/post/:id` → full post content + inquiry form. **No current caller** — kept only so an old `/post/:id` shell still sitting in a browser cache degrades to a working page instead of a dead fetch. It shares `getPostWithConference()` and `renderPostDetail()` with `handlePostPage`, so the two cannot drift. Slated for deletion; see the backlog in CLAUDE.md.

Return these with `fragmentResponse()` from `src/lib/response.ts`, which sets `Content-Type: text/html; charset=utf-8`. Never JSON, and never a hand-built `new Response`.

---

## Route registration

All routes are declared in the `ROUTES` array in `src/routes.ts`; `src/index.ts` builds a router from it with `createRouter()`. The router is custom (`src/lib/router.ts`) and supports path params via `:param` syntax. Handler signatures are:

```typescript
(request: Request, env: Env, ctx: ExecutionContext, params?: Record<string, string>) => Promise<Response>
```

The `Env` type is generated by `npm run cf-typegen` from `wrangler.toml`.

**Current routes:**

| Method | Path | Handler | File |
|---|---|---|---|
| GET | `/api/featured-conferences` | `handleFeaturedConferences` | conferences.ts |
| GET | `/api/components/create-form-auth` | `handleComponentCreateFormAuth` | components.ts |
| GET | `/api/components/conference-options` | `handleComponentConferenceOptions` | components.ts |
| GET | `/api/components/nav-user` | `handleComponentNavUser` | components.ts |
| GET | `/api/components/nav-subjects` | `handleComponentNavSubjects` | components.ts |
| GET | `/api/components/tag-options` | `handleComponentTagOptions` | components.ts |
| GET | `/api/components/share-type-options` | `handleComponentShareTypeOptions` | components.ts |
| GET | `/api/components/position-fields` | `handleComponentPositionFields` | components.ts |
| GET | `/api/components/recent-posts` | `handleComponentRecentPosts` | components.ts |
| GET | `/api/components/post/:id` | `handleComponentPost` | post-detail.ts |
| POST | `/api/post` | `handleCreatePost` | create-post.ts |
| POST | `/api/message/send` | `handleMessageSend` | messages.ts |
| GET | `/conferences` | `handleAllConferences` | all-conferences.ts |
| GET | `/conference/:slug` | `handleConferencePage` | conferences.ts |
| GET | `/subject/:slug` | `handleSubjectPage` | subjects.ts |
| GET | `/post/:id` | `handlePostPage` | post-detail.ts |
| GET | `/my-posts` | `handleMyPosts` | my-posts.ts |
| GET | `/search` | `handleSearch` | search.ts |
| GET | `/post/:id/edit` | `handleEditPostForm` | posts.ts |
| POST | `/post/:id/edit` | `handleEditPostSubmit` | posts.ts |
| GET | `/post/:id/delete` | `handleDeletePostConfirm` | posts.ts |
| POST | `/post/:id/delete` | `handleDeletePostSubmit` | posts.ts |
| GET | `/post/:id/report` | `handleReportForm` | flags.ts |
| POST | `/post/:id/report` | `handleReportSubmit` | flags.ts |
| POST | `/api/auth/start` | `handleAuthStart` | auth.ts |
| GET | `/api/auth/callback` | `handleAuthCallback` | auth.ts |
| POST | `/api/auth/logout` | `handleAuthLogout` | auth.ts |
| GET | `/api/auth/me` | `handleAuthMe` | auth.ts |

To add a new route: export a handler from the `src/routes/` module that owns that concern, then add a `{ method, path, handler }` entry to `ROUTES` in `src/routes.ts`. There is no path-prefix regex to maintain any more — `src/index.ts` asks `router.match()` whether the router owns a path and falls through to static assets otherwise. `test/assets.test.ts` reads `ROUTES` directly, so a new route is automatically checked for asset shadowing and for `run_worker_first` coverage; both fail if you forget the wrangler.toml entry. `test/route-modules.test.ts` fails if the handler is exported but never registered.

**Pick the module by concern, and do not import across route modules.** If two of them need the same thing, it belongs in `src/lib/` or `src/db/` — not in a sibling, and not in a shared `render.ts`, which would just rebuild `api.ts` a piece at a time. This is why `/api/components/post/:id` sits in `post-detail.ts` with the page it mirrors rather than in `components.ts` with the other fragments: the two share `renderPostDetail()`, and keeping them together is what keeps that helper private. `test/route-modules.test.ts` enforces both the no-cross-import rule and a size bound, since `api.ts` reached 1,199 lines one handler at a time without anything failing.

**Check for an asset collision first.** Static assets are served *before* the Worker runs, so a route at `/foo` is dead on arrival if `templates/pages/foo.njk` exists (it builds to `public/foo/index.html`). Either don't create the template, or add `/foo` to `run_worker_first` in `wrangler.toml`. This is exactly how `GET /search` was silently unreachable.

**Register routes without a trailing slash.** `Router.match()` anchors its pattern with `$`, so `/search` and `/search/` are different strings and only the first matches. `src/index.ts` handles the second form: when the router does not claim a path that ends in `/`, it retries the trimmed path, and if *that* is a registered route it issues a `308` redirect to it. The redirect is deliberately conditional — Eleventy pages genuinely are directory-style, so `/about/` must keep falling through to `env.ASSETS.fetch()` untouched. `308` rather than `301` so POST routes like `/post/:id/edit/` do not degrade into a GET. Covered by `test/routing.test.ts`.

---

## Authentication

### Session cookie

- Cookie name: `rr_session`
- Format: `{base64url(JSON payload)}.{HMAC-SHA256 signature}`
- TTL: 30 days — `SESSION_TTL_SECONDS` in `src/lib/config.ts`, the single definition behind both the cookie's `Max-Age` and the token's `exp`
- Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/`

### Verifying a session in a handler

There is no middleware — each handler that needs a session asks for one. Ask through `src/lib/guards.ts`, never `getSessionUser()` directly:

```typescript
import { requireUser } from '../lib/guards';

const guard = await requireUser(request, env, 'api');
if (!guard.ok) return guard.response;
const user = guard.value;
```

A guard returns `{ ok: true, value }` or `{ ok: false, response }` — the refusal is an ordinary value the handler returns, so there is no exception path to remember and no dependence on the surrounding try/catch.

**`mode` picks the failure shape, and the reason for each is documented on the `GuardMode` type — read it there, it is the only copy:**

| mode | Failure | For |
|---|---|---|
| `'page'` | 302 → `/login` | Full page navigations |
| `'api'` | 401 `Unauthorized`, plain text | Form POSTs and JSON endpoints |
| `'htmx'` | 200 + `HX-Redirect: /login` | Fragments swapped into a live page |

The `'htmx'` case is not a stylistic choice: HTMX issues its requests with `fetch()`, which follows a 302 transparently and would swap the entire login page into a `<div>`. It also ignores response headers on a non-2xx, so the 200 is load-bearing.

For handlers that render for everyone but render *differently* for the author — the post page, the nav — use `optionalUser(request, env)`, which returns `SessionPayload | null`. It is a deliberate word rather than a missing `if`.

`test/session-access.test.ts` fails the build if `getSessionUser` is called anywhere but `lib/guards.ts` and `handleAuthMe` (which reports the raw session as its whole purpose).

`sessionUserId(user)` converts `sub` to the number needed to compare against DB columns.

**Check the session before querying anything keyed on a user-supplied id.** Querying first leaks row existence through the status code — `handleReportForm` did exactly this, returning 302 for a real post id and 404 for a missing one to callers who were not even logged in. Every guard does the session check first, so using one gets this right by construction.

### Acting on a post the caller must own

```typescript
import { requireOwnedPost } from '../lib/guards';

const guard = await requireOwnedPost(request, env, params);
if (!guard.ok) return guard.response;
const { user, post } = guard.value;
```

Session → id parse → row fetch → ownership comparison, in one call: 302 when anonymous, 404 for a malformed id or a missing post, 403 for someone else's. It catches its own D1 errors and returns `errorPage()`, so the call needs no `try` around it.

This existed as three inline steps repeated in four handlers, and forgetting the middle one is silent. Do not re-implement it — `test/session-access.test.ts` fails on a `user_id !==` comparison in `routes/posts.ts`. Keep the `AND user_id = ?` clauses on the `UPDATE`/`DELETE` statements: the guard makes them redundant, not wrong.

### Magic link flow

1. `POST /api/auth/start` — verifies Turnstile, generates token, sends email via Mailgun
2. `GET /api/auth/callback?token=X` — verifies token, upserts user in DB, sets `rr_session` cookie, redirects to `/`

The callback is reached by clicking a link in an email, so every failure path renders a full page (via `callbackErrorPage()`) pointing back at `/login` rather than returning bare text. The whole body is wrapped in a try/catch: a throw here used to escape the handler and surface as the runtime's own bare 500 mid-login.

### Logout

`POST /api/auth/logout` clears the cookie and returns `HX-Redirect: /`, so HTMX performs a full page navigation and the nav re-renders in the logged-out state. (It previously returned `{"ok":true}`, which HTMX rendered inline as raw JSON — fixed in `c532625`.)

---

## Database

**Engine:** Cloudflare D1 (SQLite dialect)  
**Binding:** `env.DB`  
**Schema:** `migrations/*.sql`, applied in order — there is no standalone schema file  
**All queries live in `src/db/`** — see below.

### SQL lives in `src/db/`, nowhere else

Handlers call a named function; they never touch `env.DB`. `test/db-access.test.ts` fails the build if `DB.prepare` appears outside `src/db/`.

```typescript
import { getPostWithConference, searchPosts } from '../db/posts';

const post = await getPostWithConference(env, id);          // PostDetail | null
const results = await searchPosts(env, { q, tag });         // PostWithConference[]
```

Adding a query means adding a function to the module that owns the table, and its row type to `src/db/types.ts`:

```typescript
// src/db/posts.ts
export async function getPost(env: Env, id: number): Promise<Post | null> {
	return await env.DB.prepare(`SELECT id, title, description, created_at FROM posts WHERE id = ?`)
		.bind(id)
		.first<Post>();   // the generic, never `as unknown as`
}
```

Rules that hold inside `src/db/`:

- **Always `.bind()`** — never string-interpolate a value into a query.
- **Type reads with D1's generics** (`.first<T>()` / `.all<T>()`). Four `as unknown as` casts used to launder mismatched row types; `getAllConferences()` was typed `Promise<Conference[]>` over a `SELECT id, name` and nothing complained. `test/db-access.test.ts` bans the cast outright.
- **A type describes exactly the columns its query selects.** That is why `ConferenceSummary` (`id, name`) is separate from `Conference` — having the narrow type is what makes the wide lie unwritable.
- **Reads return `[]` / `null`, not `undefined`**, so handlers need no defensive checks.
- Writes take an input object (`NewPost`, `NewFlag`, …) rather than positional arguments, so a column added to an INSERT cannot silently shift the bindings.

**Parse route ids with `parseRouteId()` from `src/lib/params.ts`, never bare `parseInt()`.** `parseInt("12abc", 10)` returns `12` and `Number.isFinite()` accepts it, so a malformed URL silently resolves to an unrelated row instead of 404ing. `parseRouteId` requires the whole string to be digits and rejects zero, negatives, and values past the safe-integer range, returning `null` for anything it will not vouch for.

**There are no transactions.** D1's `batch()` runs statements atomically but cannot feed one statement's `RETURNING` output into the next, so any multi-write flow that needs a generated id is non-atomic by construction. `handleCreatePost` is the live example — see the known-limit comment there and the backlog entry in CLAUDE.md.

### Tables

**`users`** — one row per registered email address  
`id, email (unique), created_at (unix), last_login_at (unix)`

**`conferences`** — academic conferences  
`id, user_id (creator), name, slug (unique url-safe), location_address (text), city_id (FK→cities, unused in UI), start_time (unix), stop_time (unix), description, created_at (unix), is_featured (0/1)`

> **Featuring a conference is a manual D1 write, and that is the whole
> mechanism.** `is_featured = 1` is what puts a conference on the homepage's
> "Featured conferences" grid, via `listFeaturedConferences()`. There is no
> admin UI — the site has no admin concept at all (see the moderation item in
> the CLAUDE.md backlog) — so it is set by hand:
>
> ```bash
> npx wrangler d1 execute research-roomies --remote \
>   --command "UPDATE conferences SET is_featured = 1 WHERE slug = 'joint-mathematics-meetings'"
> ```
>
> Use `--local` against the dev database. `0` unfeatures. Nothing writes this
> column except a human: `createConference()` inserts `0` unconditionally, so a
> conference is never featured by being created. `listFeaturedConferences()`
> orders by `created_at DESC` and takes at most 10; the homepage grid is three
> across, so a shortlist of 3 or 6 fills the row cleanly. Featuring a conference
> that has no posts yet is normal and is often the point — it is how the first
> person finds somewhere to post.

**`posts`** — user posts seeking travel partners  
`id, user_id (FK→users), conference_id (FK→conferences), title, description, created_at (unix), position_slug (FK→positions, nullable), position_other (nullable), institution (nullable)`

> **The three authorship columns are nullable, and both forms require them
> anyway.** That is not a contradiction, it is the only honest way to add a
> mandatory field to a table that already has rows: nobody can say what the
> author of a 2026 post's position was, and a fabricated backfill
> (`'other'` / `'Unknown'`) would be indistinguishable from an answer somebody
> actually gave. So "not stated" is a permanent, legitimate state that every
> renderer and every query must handle — `listPostsForUser()` and friends
> `LEFT JOIN positions`, not `JOIN`, and an inner join there would make every
> pre-existing post vanish from every listing while passing the happy-path
> tests. The edit form requires the fields too, so a post that predates them is
> one save away from being complete; that is the deliberate contrast with
> subject tags, which can only be set at conference-creation time and left
> production permanently untaggable.

**`positions`** — curated academic positions, the sibling of `share_types`  
`slug (PK), name, sort_order` — undergraduate, graduate, postdoc, lecturer, professor, other. `sort_order` because the list runs from earliest career stage to latest and ends at 'Other Position'; alphabetical would open on 'Graduate Student' and bury 'Other Position' in the middle. `position_other` on `posts` carries the free text that only `other` has — it does not go into `position_slug` itself, which would break the foreign key and make the curated list unbounded.

**`share_types`** / **`post_share_types`** — what a post offers to share  
`slug (PK), name, sort_order` and `share_slug (FK), post_id (FK)` (composite PK). A join table rather than a column because one post really can offer a room *and* a car seat; contrast `posts.position_slug`, which is a column because a post has exactly one author with exactly one position.

**`flags`** — abuse reports on posts  
`id, post_id (FK→posts), reason, flagged_by (email), timestamp (unix)`

**`tags`** — subject categories  
`slug (PK), name`

**`conference_tags`** — many-to-many conference ↔ tag  
`tag_slug (FK→tags), conference_id (FK→conferences)` — composite PK

**`message`** — inquiry messages sent through the site  
`post_id, sender_email, recipient_email, content, timestamp` — no PK, no foreign key constraints

**`countries`, `states`, `cities`** — geo reference data (populated externally, not used in the current UI)

### Timestamp convention

All timestamps are stored as **Unix epoch seconds (INTEGER)**. Convert to/from JS:
- To store: `Math.floor(Date.now() / 1000)`
- To display: `new Date(timestamp * 1000).toLocaleDateString(...)`

### Slug generation

`reserveSlug()` in `src/db/conferences.ts` turns a conference name into a slug nothing else is using — lowercase, non-alphanumerics to `-`, then `-2`, `-3`, … until one is free, backed by a `UNIQUE` index on `conferences.slug`. Always create conferences through it: a duplicate slug makes the newer conference unreachable at `/conference/:slug`.

---

## Eleventy (static site builder)

**Config:** `eleventy.config.js`  
**Input:** `templates/pages/` (Nunjucks `.njk` files)  
**Output:** `public/`  
**Layouts:** `templates/layouts/` (referenced as `../layouts` from the pages dir)  
**CSS:** `templates/style/style.css` → copied to `public/style/style.css`

### Build command

```bash
npm run build
```

`npm run build` is `node scripts/gen-layout.mjs && eleventy` — it regenerates `templates/layouts/base.njk` from `src/lib/shell.mjs` before Eleventy runs.

Must be run after any template change before previewing with `wrangler dev`, which serves the pre-built `public/` and does not compile templates at runtime. `npm run deploy` runs the build itself (`npm run build && wrangler deploy`), so a deploy cannot ship stale HTML.

**Adding a page here can break a Worker route.** Cloudflare serves a matching static asset before invoking the Worker, so `templates/pages/foo.njk` (which builds to `public/foo/index.html`) will shadow a registered `GET /foo` handler. Either don't create the template, or add the path to `run_worker_first` in `wrangler.toml`.

### Base layout (`templates/layouts/base.njk`) — GENERATED, do not edit

Provides the full HTML shell: `<head>` with meta/OpenGraph tags, CSS and the HTMX + Turnstile CDN scripts, nav with the Login/Logout HTMX component (`#nav-user-state`), and footer. All Eleventy pages `{% extends "base.njk" %}` and fill `{% block content %}`.

**It is generated from `renderShell()` in `src/lib/shell.mjs`** by `scripts/gen-layout.mjs`, which runs ahead of Eleventy in `npm run build`. Edits to the file itself are overwritten by the next build and rejected by `test/shell.test.ts`. Change the chrome in `shell.mjs`, run `npm run build`, and commit the regenerated layout alongside it.

`renderFullPage()` in `src/lib/html.ts` calls the same `renderShell()`, so Worker-rendered and Eleventy-built pages cannot drift. `test/shell.test.ts` re-renders the committed layout with the markers the generator emitted and asserts it is byte-identical to `renderFullPage()` output — head, footer, and whole document.

`base.njk` keeps one Nunjucks slot of its own, `{% block head %}`, for per-page `<style>`/`<script>` on static pages. It is written `{%- block head %}` on purpose: the whitespace-control dash means an empty block leaves no trace, which is what keeps a static `<head>` byte-equal to a Worker `<head>`.

### Page front matter and Eleventy data

Every page in `templates/pages/` carries `title` and `description` front matter:

```yaml
---
title: About
description: One sentence, ≤160 characters, used for <meta name="description"> and OpenGraph.
---
```

`title` is **bare** — the shell appends ` – ResearchRoomies` (en dash) exactly as it does for `renderFullPage()`. Do not write the site name into a page title.

Global data lives in `eleventy.config.js`: `year` (footer copyright) and `siteOrigin` (joined with `page.url` for `<link rel="canonical">` and `og:url`). `year` used to be referenced by the layout with nothing defining it, so every built page shipped a blank year.

Subject tags are NOT Eleventy data — they live in D1 and are fetched at request time through the `/api/components/nav-subjects` and `/api/components/tag-options` HTMX fragments, so static and Worker-rendered pages show the same list without a rebuild.

---

## Styling — the Classical design system

**`templates/style/style.css` is the only stylesheet.** No framework, no build
step, no CSS-in-JS, no per-page `<style>` block. It is copied verbatim to
`public/style/style.css` and linked once from `renderShell()`, so Worker-rendered
and Eleventy-built pages are styled by the same file.

It has three layers, in this order, and each may only build on the ones above it:

| Layer | What is in it | Rule |
|---|---|---|
| 1. Tokens | the `:root` block — colors, the 100–900 ramps, fonts, `--space-*`, `--radius-*`, `--shadow-*` | Taken from the design system. Nothing below may hard-code a hex, a font name, or a px value a token already carries. |
| 2. System | `.btn*`, `.tag*`, `.card*`, `.field`/`.input`, `.seg*`, `.nav*`, `.hr`, `.table` | The design system's own components, built from layer 1 only. |
| 3. Application | page chrome, listings, the search filter row, the forms | ResearchRoomies-specific layout, built from layers 1 and 2. |

**The direction, in one line: color is stroke, not fill.** Buttons are outlined
(`.btn-primary` is an accent border on transparent), cards are bordered, and
structure is carried by hairline `--color-divider` rules rather than by boxes and
shadows. There is exactly one filled control on the site — `.btn-danger` on
"Delete permanently" — and it is filled precisely so that it does not look like
every other action. Headings set *lighter* as they get bigger: interface
headings take `--font-heading-weight` (semibold), display headings
(`.page-title`, `.post-title`, `.home-hero h1`) take the normal cut at 400.

**Fonts are loaded in `renderShell()`, not with an `@import` in the CSS.** An
`@import` cannot start fetching until the stylesheet it sits in has arrived,
which serialises two round trips on the critical path; the `<link>` plus its two
`preconnect`s overlaps the font handshake with the stylesheet fetch. `style.css`
names local serif fallbacks so a blocked or slow Google Fonts response costs
polish, not legibility.

**Numbers set tabular where they stand as figures** — dates, counts, the feed's
date rail — via the `.tnum` class. Running prose deliberately does not: Lora's
tabular feature widens its word spaces too, which loosens the paragraphs.

### Which container class a page uses

| Class | For | Note |
|---|---|---|
| *(none)* | app pages — `/search`, `/post/:id`, `/conferences`, `/conference/:slug`, `/my-posts`, `/subject/:slug` | Full `--page-width`; `.site-main` already supplies the measure and gutter. |
| `.form-page` | `/post/:id/edit`, `/post/:id/delete`, `/post/:id/report` | A 640px measure for a column of fields. |
| `.site-page` | prose — About, Terms, Privacy, Safety, How It Works, 404, and the shared 403/404/500 pages | Justifies its paragraphs at a 74ch measure. **Do not use it for a form**: justified text under an input is wrong. |

`.page-head` (title + lede + optional action, closed by a hairline) opens every
app page; `.with-aside` is the content-plus-300px-aside grid; `.listing` /
`.listing-item` is the post row shared by `/search`, `/conference/:slug` and the
homepage feed.

### Changing the look

Retune the tokens at the top of `style.css` and the whole site follows. Adding a
new component class is the second choice; a one-off inline `style=` attribute is
the wrong one — there are none left in `src/` or `templates/`, and the point of
having a system is that the next page does not have to re-decide.

---

## Cloudflare Turnstile (CAPTCHA)

Site key: `TURNSTILE_SITE_KEY` in `[vars]` in `wrangler.toml` — **the single definition**. It used to be a literal repeated at four sites across two languages, so rotating the widget took four edits.  
Secret key: `env.TURNSTILE_SECRET_KEY` (a secret; never move it into `[vars]`)  
Verification endpoint: `https://challenges.cloudflare.com/turnstile/v0/siteverify`

Two consumers read that one var:

- **Worker-rendered forms** call `turnstileWidget(env)` from `src/lib/turnstile.ts`, which emits the whole `<div class="cf-turnstile">`. Never write the div by hand.
- **Eleventy pages** use `{{ turnstileSiteKey }}`, an Eleventy global. `eleventy.config.js` reads it back out of `wrangler.toml` at build time and **throws if it is missing**, so `npm run deploy` (which builds first) cannot ship a dead widget.

The client script is loaded once, by `renderShell()` in `src/lib/shell.mjs`, which is where both the generated `base.njk` and `renderFullPage()` get it — so any page gets a working widget just by emitting the div.

Always verify with `verifyTurnstile(token, request, env)` from `src/lib/turnstile.ts`. **A missing token is a failure, not a skip.** Handlers used to guard with `if (token) { verify }`, which meant anything omitting the field passed unchallenged — and since the script was only loaded on `/login`, that was every create-post and inquiry submission.

Required on: login, post creation, message sending, post reporting.

---

## Email (Mailgun)

**Domain:** `config.mailgun.domain` — `researchroomies.com` unless `MAILGUN_DOMAIN` overrides it  
**API key:** `env.MAILGUN_API_KEY`  
**Sending address:** determined by `env.MAILGUN_SENDING_KEY`. ⚠️ **This variable is misnamed: it is a From address, not a key.** If set to a full address it is used as-is; if set to a bare local part (`login`) the Mailgun domain is appended. When it is unset each message falls back to its own local part — `login@` for the magic link, `noreply@` for everything else. `getConfig()` normalizes it to `config.mailgun.from` (a full address, or `null` for "use the per-message local part"). The name is kept only because renaming it means rotating a deployed secret.

**Functions in `src/lib/mailgun.ts`:**
- `sendMagicLink(email, link, env)` — login email. Never log the `link`; it carries a valid login token.
- `sendInquiryEmail(authorEmail, senderEmail, postTitle, content, env)` — inquiry notification; uses `Reply-To` so the author can reply directly to the sender
- `sendReportEmail(postId, postTitle, reason, reporterEmail, env)` — abuse report to `admin@researchroomies.com`. Best-effort: the `flags` row is the source of truth and a failed send must never fail the report.

All of these return `boolean` rather than throwing, so callers must check the result.

**Escape every user-supplied value going into an HTML email body** with `escapeHtmlForEmail()` (local to `mailgun.ts`). These bodies are read by a third party — a post author, or the admin — so an unescaped title or message is HTML injection into someone else's inbox. The plain-text bodies and the `subject` field need no escaping: text has nothing to inject into, and Mailgun's `subject` travels as a `FormData` field, so newlines cannot become header injection.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `AUTH_HMAC_SECRET` | Secret for signing/verifying magic link and session tokens |
| `MAILGUN_API_KEY` | Mailgun API key |
| `MAILGUN_SENDING_KEY` | **Not a key** — the From address, or its local part (e.g. `login`). See the Email section |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret key. Stays a secret; never move it into `[vars]` |

Set via `wrangler secret put <VAR>` for production. For local dev, add to `.dev.vars` (not committed).

### Plain vars (not secrets)

Declared in `[vars]` in `wrangler.toml`, committed, and changed by editing that file and redeploying.

| Variable | Default | Purpose |
|---|---|---|
| `RESTRICT_EDU_EMAILS` | `"false"` | `"true"` limits accounts to addresses ending in `.edu` |
| `TURNSTILE_SITE_KEY` | — (required) | Public Turnstile sitekey. The one definition; both the Worker and the Eleventy build read it |

### Optional overrides

Read by `getConfig()` in `src/lib/config.ts`. **None of these are set today**, and every default reproduces the literal that used to be hardcoded, so leaving them unset is exactly current production behaviour. Add to `[vars]` (or pass `--var` in dev) only when standing up a second environment.

| Variable | Default | Purpose |
|---|---|---|
| `APP_ORIGIN` | the origin of the request being served | Origin used to build emailed links. Overriding pins it; leaving it unset means a staging deployment links to itself |
| `MAILGUN_DOMAIN` | `researchroomies.com` | Mailgun sending domain |
| `MAILGUN_API_BASE` | `https://api.mailgun.net/v3` | Region-specific; EU domains need `https://api.eu.mailgun.net/v3` |
| `ADMIN_EMAIL` | `admin@researchroomies.com` | Abuse-report recipient and the contact address in error copy |

### Configuration module

`src/lib/config.ts` is the only place a deployment literal is defined. `getConfig(env, request?)` returns `origin`, `sessionTtlSeconds`, `magicLinkTtlSeconds`, `turnstileSiteKey`, `mailgun` and `adminEmail`.

Two rules follow from why it exists:

- **The session TTL is defined once** (`SESSION_TTL_SECONDS`). The session cookie's `Max-Age` and the token's `exp` used to come from two independent 30-day constants in two files, agreeing by coincidence. `handleAuthCallback` now derives both from one local. If they ever diverge, users are silently logged out — never reintroduce a second constant.
- **The origin is derived, not hardcoded.** `APP_ORIGIN` if set, otherwise `new URL(request.url).origin`. Callers with no request in hand (`sendReportEmail`) fall back to the production default, which is what those absolute links always were.

### `RESTRICT_EDU_EMAILS`

The gate lives in `isEmailAllowed()` (`src/lib/auth.ts`) and is applied in both `handleAuthStart` and `handleAuthCallback`. It fails open — any value other than the literal string `"true"`, including the var being absent, allows all addresses. Override locally with `npx wrangler dev --var RESTRICT_EDU_EMAILS:true`.

Enabling it rejects international academic domains (`.ac.uk`, `.edu.au`) and locks out existing non-`.edu` users, not just new signups. See CLAUDE.md before flipping it.

---

## Development workflow

```bash
npm run dev        # Start local Wrangler dev server (Workers + D1)
npm run build      # Generate base.njk from shell.mjs, then build Eleventy pages into public/
npm run check      # build && vitest run && tsc --noEmit — the full gate, in the right order
npm run deploy     # Build + deploy to Cloudflare (runs the build then wrangler deploy)
npm run test       # Run Vitest in watch mode
npm run cf-typegen # Regenerate Env type from wrangler.toml
```

**Use `npm run check` after a clean checkout or before a deploy.** The order matters: `test/assets.test.ts` reads the Eleventy output in `public/`, so testing before building either fails loudly or tests a stale tree.

**Important:** `npm run dev` serves the Worker but does NOT auto-rebuild Eleventy templates. If you change a `.njk` file, run `npm run build` separately, then restart `wrangler dev`.

### `wrangler dev` rewrites the request host

Because `wrangler.toml` declares `[[routes]] pattern = "researchroomies.com"`, `wrangler dev` synthesizes the request URL from that route (`--local-upstream` defaults to "dev.host or route"). Inside the Worker, `new URL(request.url).origin` is therefore `http://researchroomies.com` even though you connected to `localhost:8787` — so a magic link generated by plain `npm run dev` is **not** clickable locally. To exercise the login flow end-to-end, pin the origin:

```bash
npx wrangler dev --port 8787 --local-upstream localhost:8787 --upstream-protocol http
# or, equivalently for links only:
npx wrangler dev --port 8787 --var APP_ORIGIN:http://localhost:8787
```

The host must include the port; `--local-upstream localhost` yields `http://localhost` with the port dropped.

**Never point a local run at the real Mailgun API while testing the login or report flows** — `.dev.vars` holds a live key and third parties receive whatever you send. Stub it instead: `--var MAILGUN_API_BASE:http://127.0.0.1:8899/v3` and run any HTTP server on that port to capture the multipart body. Pair it with Cloudflare's always-passing Turnstile test secret, `--var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA`, so forms submit without a browser. CLI `--var` does override `.dev.vars`.

---

## Testing

**Framework:** Vitest with `@cloudflare/vitest-pool-workers` (config in `vitest.config.mts`)

| File | Covers |
|---|---|
| `test/auth_verification.test.ts` | Magic link and session token generation, verification, signature tamper detection |
| `test/routing.test.ts` | Router matching, path params, trailing-slash behaviour |
| `test/params.test.ts` | `parseRouteId()` — rejects `12abc`, `0`, negatives, oversized ids |
| `test/shell.test.ts` | The generated `base.njk` against `renderFullPage()` — head, footer and whole document byte for byte, plus the title/year/meta contracts |
| `test/assets.test.ts` | Every route in `ROUTES` is unshadowed by `public/` and covered by `run_worker_first` |
| `test/config.test.ts` | `getConfig()` defaults (each one pins a literal that used to be hardcoded), origin derivation and `APP_ORIGIN` override, `magicLinkUrl()`, Mailgun From resolution, and that the session token's `exp - iat` equals `SESSION_TTL_SECONDS` |
| `test/guards.test.ts` | `requireUser()` across three modes × every way a session can be absent, and the exact failure shape of each mode |
| `test/session-access.test.ts` | Greps: no `getSessionUser` outside guards, no hand-written ownership comparison, no `siteverify` outside `lib/turnstile.ts` |
| `test/db-access.test.ts` | Greps: no `DB.prepare`/`DB.batch`/SQL outside `src/db/`, no `as unknown as` anywhere in `src/`, no row shape declared outside `src/db/types.ts` |
| `test/search.test.ts` | `/search` against a real D1 — each filter alone, the combinations, `escapeLike`, ordering, and the 50-result cap |
| `test/handlers.test.ts` | `handleCreatePost`, `handleMyPosts`, `handleEditPostSubmit`, `handleDeletePostSubmit` against a real D1 — including that a refusal writes nothing and a stranger's edit changes no row |
| `test/all-conferences.test.ts` | `/conferences` against a real D1 — a conference under each of its subjects, untagged ones in the trailing group, empty subjects omitted, group ordering, and post counts that do not multiply by subject count |
| `test/positions.test.ts` | Position and institution against a real D1 — `resolvePosition()` rejecting rather than dropping, a refused create writing neither post nor conference, the edit form completing a post that predates the fields, the LEFT JOIN keeping such posts in listings, and the byline on every surface |

### Writing a handler test

`@cloudflare/vitest-pool-workers` provides a real D1 in process, so handler
tests run against real SQL rather than a fake `env.DB` — which is the point, as
a fake returns whatever rows the test hands it and so cannot fail on a bad
binding or a filter that matches everything.

`test/helpers/seed.ts` has the fixtures: `resetDatabase()`, `seedUser` /
`seedConference` / `seedPost`, `sessionCookie(userId)`, `testRequest(path, …)`
and `expectTurnstile(success)`.

`resetDatabase()` applies `migrations/*.sql` **file by file, recording each one
in a `d1_migrations` table** exactly as `wrangler d1 migrations apply` does, then
empties every table but the curated `tags` / `share_types` / `positions` lists.
The tracking is not decoration: everything up to `0003` was
`CREATE TABLE IF NOT EXISTS` or an upsert, so re-applying the whole chain on
every reset happened to be a no-op, but `ALTER TABLE … ADD COLUMN` has no
`IF NOT EXISTS` form and fails outright the second time. The tracking table lives
in the same storage as the schema, so the two are rolled back together whichever
way the pool's isolation is configured.

`seedPost()` leaves `position` and `institution` **null by default**, i.e. it
seeds a post written before those fields existed. That is deliberate: production
is full of such rows, and a fixture that always filled them in would let a
renderer that cannot survive a null pass the entire suite. Pass
`position: { slug, other }` and `institution` when a test needs them.

```typescript
beforeEach(async () => {
	await resetDatabase();
	fetchMock.activate();
	fetchMock.disableNetConnect();   // .dev.vars holds live credentials
});

const userId = await seedUser('prof@university.edu');
const response = await handleMyPosts(
	testRequest('/my-posts', { cookie: await sessionCookie(userId) }),
	testEnv,
	createExecutionContext(),
);
```

`testEnv` overrides `AUTH_HMAC_SECRET` and `TURNSTILE_SECRET_KEY` so no test
depends on `.dev.vars`, and any handler that verifies Turnstile needs an
`expectTurnstile()` interceptor or the call fails loudly instead of reaching
Cloudflare.

**Two vitest projects.** `vitest.config.mts` declares a `workers` project (runs in
workerd via `@cloudflare/vitest-pool-workers`) and a `node` project for the three
grep-based guard files, which need `node:fs` to read source, `public/` and
`wrangler.toml`. `vitest run` with no arguments runs both — do not narrow it.
Those guard tests require a built `public/`; they throw a pointed error rather
than skipping if it is missing, so run `npm run check` (build, then test, then
`tsc`) after a clean checkout.

To add tests for new routes, use the Cloudflare vitest pool which provides a real Workers-like runtime with D1 bindings.

### Running anything that spawns workerd (GNU Guix System)

`wrangler dev`, `wrangler d1 execute --local`, and `vitest` all spawn `workerd`, a prebuilt ELF binary hardcoded to the interpreter `/lib64/ld-linux-x86-64.so.2`. That path does not exist on Guix System, so they fail with a misleading error: `spawn .../workerd ENOENT` from wrangler, or `no such file or directory` from the shell even though `ls` shows the binary right there.

Do **not** fix this with `patchelf` or by installing an FHS loader system-wide — it breaks config-as-code purity. Run the toolchain in an FHS container instead:

```bash
guix shell --container --emulate-fhs --network \
  node bash coreutils grep curl sed gawk findutils nss-certs \
  -- bash -c 'npx vitest run'
```

- The Guix package is `node` (there is no `node-lts`).
- `--container` maps the current working directory; use `--share=/abs/path` for anything outside it.
- Env vars are not preserved into the container — pass them inline or with `--preserve='^PATTERN$'`.
- `nss-certs` is needed for TLS egress (npm, Mailgun, Turnstile siteverify).
- `--network` shares the host network namespace, so a dev server bound to `127.0.0.1:8788` inside the container is reachable from the host.

---

## Common patterns and pitfalls

### Adding a new protected API endpoint

1. `const guard = await requireUser(request, env, mode)` from `../lib/guards`, with `mode` picked from the table above. Do this **first**, before any DB lookup keyed on a user-supplied id; `if (!guard.ok) return guard.response`
2. Do not invent a fourth answer to "not logged in". If none of the three modes fits, that is a change to `GuardMode`, made once, with the reason written down there
3. Parse ids with `parseRouteId()`; treat `null` as 404, never as "try anyway"
4. For anything mutating a post, use `requireOwnedPost()` — it re-loads the row and compares ownership, so an id from the form body is never trusted
5. Reach the database through `src/db/`, never `env.DB` — add a function to the module that owns the table, and its row type to `src/db/types.ts`
6. Verify Turnstile on anything a bot could hammer
7. Escape every interpolated value with `escapeHtml()`
8. Wrap the handler body in try/catch and return a rendered error page — a throw that escapes becomes the runtime's bare 500 with no page. Log the real error with `console.error`; **never** put `err.message` in the response, it leaks D1 table and constraint names
9. Register the route in `ROUTES` (`src/routes.ts`), without a trailing slash, and add a covering pattern to `run_worker_first` in `wrangler.toml`

### Adding a new Eleventy page

1. Confirm the page is genuinely static. If it needs DB or session data, it belongs in the Worker — do not create a shell that fetches its own content
2. Create `templates/pages/yourpage.njk`, extend `base.njk`, and give it `title` (bare, no site name) and `description` front matter — the shell builds the title, meta description, OpenGraph tags and canonical link from them
3. Run `npm run build` — Eleventy outputs `public/yourpage/index.html`
4. The Worker will serve it automatically via `env.ASSETS.fetch()`
5. No route registration needed in `src/routes.ts` unless the page needs dynamic data

Deleting a `.njk` file does not remove its already-built output from `public/`, and a stale `index.html` there will shadow a Worker route. Delete the built directory too.

### Adding a new HTMX component endpoint

1. Add a handler in `src/routes/components.ts` that returns an HTML fragment (no `<!DOCTYPE>`) — or, if it shares a renderer with a full page, in that page's module, as `handleComponentPost` does in `post-detail.ts`
2. Return it with `fragmentResponse()` from `src/lib/response.ts`
3. Choose `opts.cache` deliberately. It defaults to `'private'`, which is the safe answer for anything that varies by session — `nav-user` depends on it. Use `'public-long'` only for genuinely session-independent reference data such as the tag list
4. Register `GET /api/components/yourcomponent` in `ROUTES` (`src/routes.ts`)
5. In the template, use `hx-get="/api/components/yourcomponent" hx-trigger="load" hx-swap="..."` on the target element

### Building responses

Never hand-build `new Response(html, { headers: { "Content-Type": ... } })`.
Everything HTML goes through `src/lib/response.ts`:

| Function | Use for |
|---|---|
| `pageResponse(title, content, opts?)` | A full Worker-rendered page. Wraps `renderFullPage()`. |
| `fragmentResponse(html, opts?)` | An `/api/components/*` HTMX fragment. |
| `htmlResponse(body, opts?)` | The primitive the other two use. |
| `notFoundPage(what?)` / `forbiddenPage(reason?)` / `errorPage()` | 404 / 403 / 500. |

`opts.cache` is a closed union — `'public-short'` (5 min), `'public-long'`
(1 hour), `'private'`, `'none'` (`no-store`) — so the policy is picked from a
menu instead of retyped. **It defaults to `'private'`**: public caching is
opt-in, because a session-varying fragment cached publicly serves one viewer's
page to the next. `charset=utf-8` is written once, inside the module.

`errorPage()` deliberately takes no argument. A handler once returned
`"Internal Server Error: " + err.message` and put D1 constraint and table names
in front of the client; there is now no parameter to put them in. Log the error,
return `errorPage()`.

### Escaping Worker-rendered HTML

Worker HTML is built by string concatenation, so **every interpolated value that could originate from a user or the database must pass through `escapeHtml()`** from `src/lib/html.ts` — post titles, descriptions, conference names, locations, page titles, meta tags. There is no template engine doing it for you. Missing this was a live stored-XSS bug. Use `encodeURIComponent()` for values going into a URL path or query string, not `escapeHtml()`.

Email bodies use the separate `escapeHtmlForEmail()` in `mailgun.ts` — see the Email section.

### Changing the page chrome

Edit `renderShell()` in `src/lib/shell.mjs`, then run `npm run build` and commit the regenerated `templates/layouts/base.njk` with it. That is the whole procedure — there is no second copy to update.

This used to read "any nav, header, or footer change must be made in both," which is how `/my-posts` and `/conference/:slug` once rendered with no Login/Logout button at all: `renderFullPage()` was a separate copy and lost `#nav-user-state`. `test/shell.test.ts` now diffs the two rendered documents byte for byte, so that class of drift fails the test suite instead of reaching production.

Per-page `<head>` content still has two entry points, because static and dynamic pages get it from different places: `{% block head %}` (plus `title` / `description` front matter) for Eleventy pages, the `options` argument for `renderFullPage()`. Both feed the same `renderShell()` parameters.

### D1 integer booleans

SQLite has no boolean type. `is_featured` and similar flags use `INTEGER` with values `0` and `1`. Do not use `true`/`false` in queries.

---

## Pending work

See `CLAUDE.md` for the current backlog of planned features and fixes, including exact file paths and implementation notes for each item.
