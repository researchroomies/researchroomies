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
│   ├── index.ts              # Worker entry point – route registration, trailing-slash
│   │                         #   redirect, static asset fallback
│   ├── routes/
│   │   ├── api.ts            # Page renders + API handlers
│   │   ├── auth.ts           # Magic link login/logout/session
│   │   ├── posts.ts          # Author-only post edit/delete
│   │   └── flags.ts          # Post reporting
│   └── lib/
│       ├── auth.ts           # Token generation/verification (HMAC-SHA256), .edu gate
│       ├── session.ts        # getSessionUser() / sessionUserId() – cookie → payload
│       ├── html.ts           # escapeHtml, date formatting, renderFullPage, summarize
│       ├── params.ts         # parseRouteId() – strict numeric route ids
│       ├── turnstile.ts      # verifyTurnstile()
│       ├── mailgun.ts        # Email sending (magic link, inquiry, abuse report)
│       └── router.ts         # Custom path-param router
├── templates/
│   ├── pages/                # Eleventy source pages (Nunjucks .njk)
│   ├── style/style.css       # Source CSS – copied to public/style/
│   └── layouts/
│       └── base.njk          # Base HTML layout (header, footer, HTMX)
├── public/                   # Eleventy output – DO NOT EDIT DIRECTLY (gitignored)
├── db/
│   └── schema.sql            # D1 schema (SQLite)
├── test/
│   ├── auth_verification.test.ts   # Magic link + session token crypto
│   ├── routing.test.ts             # Router matching + trailing slashes
│   └── params.test.ts              # parseRouteId()
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

`/conference/:slug`, `/subject/:slug`, `/post/:id`, `/my-posts`, `/search`, and the post edit/delete/report pages are rendered server-side by the Worker using `renderFullPage()` from `src/lib/html.ts`. It is a hand-maintained twin of `base.njk` and renders the same nav, **including** the `#nav-user-state` and `#nav-subjects` HTMX spans.

Signature:

```typescript
renderFullPage(title, content, options?: { description?, canonicalUrl? })
```

`title` is bare — the function appends ` – ResearchRoomies` and escapes it. `options` is the equivalent of `base.njk`'s `{% block head %}`: `description` fills `<meta name="description">` plus the OpenGraph tags, `canonicalUrl` fills `og:url` and `<link rel="canonical">`. Set them on any page with real indexable content; `summarize(text, maxLength)` in the same module collapses whitespace and truncates on a word boundary for that purpose.

When you add a new Worker-rendered page, render it through `renderFullPage()` and register it in `src/index.ts`.

**Do not build a static shell that fetches its own content.** `/post/:id` used to ship "Loading post details…" plus inline JS that re-parsed the id out of `window.location` to call `/api/components/post/:id` — three round trips, and crawlers and link unfurlers got no title or description for the site's primary entity. No page is on that pattern any more.

### 3. HTMX component fragments

Routes under `/api/components/*` return raw HTML fragments (no `<!DOCTYPE>` wrapper). HTMX swaps these into the DOM. Examples:

- `GET /api/components/nav-user` → login/logout link, swapped into `#nav-user-state`
- `GET /api/components/nav-subjects` → subject links for the nav
- `GET /api/components/create-form-auth` → email field for create form (or redirect if unauthenticated)
- `GET /api/components/conference-options` → `<option>` list for conference dropdown
- `GET /api/components/tag-options` → `<option>` list for subject filters and the create-post picker
- `GET /api/components/post/:id` → full post content + inquiry form. **No current caller** — kept only so an old `/post/:id` shell still sitting in a browser cache degrades to a working page instead of a dead fetch. It shares `getPostDetail()` and `renderPostDetail()` with `handlePostPage`, so the two cannot drift. Slated for deletion; see the backlog in CLAUDE.md.

These responses should return `Content-Type: text/html` and never JSON.

---

## Route registration

All routes are registered in `src/index.ts`. The router is custom (`src/lib/router.ts`) and supports path params via `:param` syntax. Handler signatures are:

```typescript
(request: Request, env: Env, ctx: ExecutionContext, params?: Record<string, string>) => Promise<Response>
```

The `Env` type is generated by `npm run cf-typegen` from `wrangler.toml`.

**Current routes:**

| Method | Path | Handler | File |
|---|---|---|---|
| GET | `/api/featured-conferences` | `handleFeaturedConferences` | api.ts |
| GET | `/api/components/create-form-auth` | `handleComponentCreateFormAuth` | api.ts |
| GET | `/api/components/conference-options` | `handleComponentConferenceOptions` | api.ts |
| GET | `/api/components/nav-user` | `handleComponentNavUser` | api.ts |
| GET | `/api/components/nav-subjects` | `handleComponentNavSubjects` | api.ts |
| GET | `/api/components/tag-options` | `handleComponentTagOptions` | api.ts |
| GET | `/api/components/post/:id` | `handleComponentPost` | api.ts |
| POST | `/api/post` | `handleCreatePost` | api.ts |
| POST | `/api/message/send` | `handleMessageSend` | api.ts |
| GET | `/conference/:slug` | `handleConferencePage` | api.ts |
| GET | `/subject/:slug` | `handleSubjectPage` | api.ts |
| GET | `/post/:id` | `handlePostPage` | api.ts |
| GET | `/my-posts` | `handleMyPosts` | api.ts |
| GET | `/search` | `handleSearch` | api.ts |
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

To add a new route: export a handler from a file in `src/routes/`, then call `router.add(method, path, handler)` in `src/index.ts`. There is no path-prefix regex to maintain any more — `src/index.ts` asks `router.match()` whether the router owns a path and falls through to static assets otherwise.

**Check for an asset collision first.** Static assets are served *before* the Worker runs, so a route at `/foo` is dead on arrival if `templates/pages/foo.njk` exists (it builds to `public/foo/index.html`). Either don't create the template, or add `/foo` to `run_worker_first` in `wrangler.toml`. This is exactly how `GET /search` was silently unreachable.

**Register routes without a trailing slash.** `Router.match()` anchors its pattern with `$`, so `/search` and `/search/` are different strings and only the first matches. `src/index.ts` handles the second form: when the router does not claim a path that ends in `/`, it retries the trimmed path, and if *that* is a registered route it issues a `308` redirect to it. The redirect is deliberately conditional — Eleventy pages genuinely are directory-style, so `/about/` must keep falling through to `env.ASSETS.fetch()` untouched. `308` rather than `301` so POST routes like `/post/:id/edit/` do not degrade into a GET. Covered by `test/routing.test.ts`.

---

## Authentication

### Session cookie

- Cookie name: `rr_session`
- Format: `{base64url(JSON payload)}.{HMAC-SHA256 signature}`
- TTL: 30 days
- Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/`

### Verifying a session in a handler

There is no middleware — each handler that needs a session asks for one. Use `getSessionUser()` from `src/lib/session.ts`; do **not** hand-roll cookie parsing:

```typescript
import { getSessionUser, sessionUserId } from '../lib/session';

const user = await getSessionUser(request, env);
if (!user) return new Response('Unauthorized', { status: 401 });
```

`getSessionUser` returns a `SessionPayload` (`sub` = user id as a string, `email`) or `null` when the request is anonymous or the token is missing, expired, or tampered with. `sessionUserId(user)` converts `sub` to the number needed to compare against DB columns.

**Check the session before querying anything keyed on a user-supplied id.** Querying first leaks row existence through the status code — `handleReportForm` did exactly this, returning 302 for a real post id and 404 for a missing one to callers who were not even logged in.

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
**Schema:** `db/schema.sql`

### D1 query patterns

```typescript
// Single row
const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<{ id: number }>();

// Multiple rows
const { results } = await env.DB.prepare('SELECT * FROM posts WHERE conference_id = ?').bind(id).all();

// Insert with RETURNING
const result = await env.DB.prepare('INSERT INTO ... RETURNING id').bind(...).first<{ id: number }>();

// Update/delete
await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, id).run();
```

Always use `.bind()` — never string-interpolate values into queries.

**Parse route ids with `parseRouteId()` from `src/lib/params.ts`, never bare `parseInt()`.** `parseInt("12abc", 10)` returns `12` and `Number.isFinite()` accepts it, so a malformed URL silently resolves to an unrelated row instead of 404ing. `parseRouteId` requires the whole string to be digits and rejects zero, negatives, and values past the safe-integer range, returning `null` for anything it will not vouch for.

**There are no transactions.** D1's `batch()` runs statements atomically but cannot feed one statement's `RETURNING` output into the next, so any multi-write flow that needs a generated id is non-atomic by construction. `handleCreatePost` is the live example — see the known-limit comment there and the backlog entry in CLAUDE.md.

### Tables

**`users`** — one row per registered email address  
`id, email (unique), created_at (unix), last_login_at (unix)`

**`conferences`** — academic conferences  
`id, user_id (creator), name, slug (unique url-safe), location_address (text), city_id (FK→cities, unused in UI), start_time (unix), stop_time (unix), description, created_at (unix), is_featured (0/1)`

**`posts`** — user posts seeking travel partners  
`id, user_id (FK→users), conference_id (FK→conferences), title, description, created_at (unix)`

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

Slugs are generated from conference names by `generateSlug()` in `api.ts`:
```typescript
title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
```
`generateUniqueSlug()` wraps this and suffixes collisions (`-2`, `-3`, …), backed by a `UNIQUE` index on `conferences.slug`. Always create conferences through it — a duplicate slug makes the newer conference unreachable at `/conference/:slug`.

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

Must be run after any template change before deploying. The Worker serves `public/` as static assets — templates are not compiled at runtime. Note that `npm run deploy` does **not** build; run `npm run build` first or you will ship stale HTML.

**Adding a page here can break a Worker route.** Cloudflare serves a matching static asset before invoking the Worker, so `templates/pages/foo.njk` (which builds to `public/foo/index.html`) will shadow a registered `GET /foo` handler. Either don't create the template, or add the path to `run_worker_first` in `wrangler.toml`.

### Base layout (`templates/layouts/base.njk`)

Provides the full HTML shell: `<head>` with CSS + HTMX CDN, nav with Login/Logout HTMX component (`#nav-user-state`), and footer. All Eleventy pages `{% extends "base.njk" %}` and fill `{% block content %}`.

The `renderFullPage()` function in `src/lib/html.ts` is a separate copy of this shell used for Worker-rendered pages. Both copies render the same nav, including `#nav-user-state` and `#nav-subjects`. `base.njk`'s `{% block head %}` corresponds to `renderFullPage()`'s `options` argument. Keep the two in sync — see "Keeping the two layouts in sync" below.

### Eleventy data

`year` comes from Eleventy's built-ins. Subject tags are NOT Eleventy data — they live in D1 and are fetched at request time through the `/api/components/nav-subjects` and `/api/components/tag-options` HTMX fragments, so static and Worker-rendered pages show the same list without a rebuild.

---

## Cloudflare Turnstile (CAPTCHA)

Site key hardcoded in templates: `0x4AAAAAAByAHmDummOs9UGm`  
Secret key: `env.TURNSTILE_SECRET_KEY`  
Verification endpoint: `https://challenges.cloudflare.com/turnstile/v0/siteverify`

The client script is loaded once in `templates/layouts/base.njk` and in `renderFullPage()`, so any page gets a working widget just by emitting `<div class="cf-turnstile" data-sitekey="...">`.

Always verify with `verifyTurnstile(token, request, env)` from `src/lib/turnstile.ts`. **A missing token is a failure, not a skip.** Handlers used to guard with `if (token) { verify }`, which meant anything omitting the field passed unchallenged — and since the script was only loaded on `/login`, that was every create-post and inquiry submission.

Required on: login, post creation, message sending, post reporting.

---

## Email (Mailgun)

**Domain:** `researchroomies.com`  
**API key:** `env.MAILGUN_API_KEY`  
**Sending address:** determined by `env.MAILGUN_SENDING_KEY` (if set to a full address, used as-is; if set to a local part, appended with `@researchroomies.com`)

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
| `MAILGUN_SENDING_KEY` | Sending address or local part (e.g. `login`) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret key |

Set via `wrangler secret put <VAR>` for production. For local dev, add to `.dev.vars` (not committed).

### Plain vars (not secrets)

Declared in `[vars]` in `wrangler.toml`, committed, and changed by editing that file and redeploying.

| Variable | Default | Purpose |
|---|---|---|
| `RESTRICT_EDU_EMAILS` | `"false"` | `"true"` limits accounts to addresses ending in `.edu` |

The gate lives in `isEmailAllowed()` (`src/lib/auth.ts`) and is applied in both `handleAuthStart` and `handleAuthCallback`. It fails open — any value other than the literal string `"true"`, including the var being absent, allows all addresses. Override locally with `npx wrangler dev --var RESTRICT_EDU_EMAILS:true`.

Enabling it rejects international academic domains (`.ac.uk`, `.edu.au`) and locks out existing non-`.edu` users, not just new signups. See CLAUDE.md before flipping it.

---

## Development workflow

```bash
npm run dev        # Start local Wrangler dev server (Workers + D1)
npm run build      # Build Eleventy static pages into public/
npm run deploy     # Build + deploy to Cloudflare (runs Eleventy then wrangler deploy)
npm run test       # Run Vitest tests
npm run cf-typegen # Regenerate Env type from wrangler.toml
```

**Important:** `npm run dev` serves the Worker but does NOT auto-rebuild Eleventy templates. If you change a `.njk` file, run `npm run build` separately, then restart `wrangler dev`.

---

## Testing

**Framework:** Vitest with `@cloudflare/vitest-pool-workers` (config in `vitest.config.mts`)

| File | Covers |
|---|---|
| `test/auth_verification.test.ts` | Magic link and session token generation, verification, signature tamper detection |
| `test/routing.test.ts` | Router matching, path params, trailing-slash behaviour |
| `test/params.test.ts` | `parseRouteId()` — rejects `12abc`, `0`, negatives, oversized ids |

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

1. `const user = await getSessionUser(request, env)` from `../lib/session` — returns null when anonymous. Do this **first**, before any DB lookup keyed on a user-supplied id
2. Return `401` (API/POST endpoints) or redirect to `/login` (page loads) if `user` is null
3. Parse ids with `parseRouteId()`; treat `null` as 400/404, never as "try anyway"
4. For anything mutating, re-load the row and compare against `sessionUserId(user)` — never trust an id from the form body
5. Verify Turnstile on anything a bot could hammer
6. Escape every interpolated value with `escapeHtml()`
7. Wrap the handler body in try/catch and return a rendered error page — a throw that escapes becomes the runtime's bare 500 with no page. Log the real error with `console.error`; **never** put `err.message` in the response, it leaks D1 table and constraint names
8. Register the route in `src/index.ts`, without a trailing slash

### Adding a new Eleventy page

1. Confirm the page is genuinely static. If it needs DB or session data, it belongs in the Worker — do not create a shell that fetches its own content
2. Create `templates/pages/yourpage.njk`, extend `base.njk`
3. Run `npm run build` — Eleventy outputs `public/yourpage/index.html`
4. The Worker will serve it automatically via `env.ASSETS.fetch()`
5. No route registration needed in `src/index.ts` unless the page needs dynamic data

Deleting a `.njk` file does not remove its already-built output from `public/`, and a stale `index.html` there will shadow a Worker route. Delete the built directory too.

### Adding a new HTMX component endpoint

1. Add a handler in `src/routes/api.ts` that returns an HTML fragment (no `<!DOCTYPE>`)
2. Return `Content-Type: text/html`
3. Register `GET /api/components/yourcomponent` in `src/index.ts`
4. In the template, use `hx-get="/api/components/yourcomponent" hx-trigger="load" hx-swap="..."` on the target element

### Escaping Worker-rendered HTML

Worker HTML is built by string concatenation, so **every interpolated value that could originate from a user or the database must pass through `escapeHtml()`** from `src/lib/html.ts` — post titles, descriptions, conference names, locations, page titles, meta tags. There is no template engine doing it for you. Missing this was a live stored-XSS bug. Use `encodeURIComponent()` for values going into a URL path or query string, not `escapeHtml()`.

Email bodies use the separate `escapeHtmlForEmail()` in `mailgun.ts` — see the Email section.

### Keeping the two layouts in sync

`renderFullPage()` (in `src/lib/html.ts`) is the server-side twin of `templates/layouts/base.njk`. Both render the same nav, including the `#nav-user-state` and `#nav-subjects` HTMX spans. They are separate copies, so **any nav, header, or footer change must be made in both** — otherwise Worker-rendered pages drift out of sync with static ones, which is how `/my-posts` and `/conference/:slug` previously rendered with no Login/Logout button at all.

`base.njk`'s `{% block head %}` and `renderFullPage()`'s `options` argument are the same seam for per-page `<head>` content; extend both together too.

### D1 integer booleans

SQLite has no boolean type. `is_featured` and similar flags use `INTEGER` with values `0` and `1`. Do not use `true`/`false` in queries.

---

## Pending work

See `CLAUDE.md` for the current backlog of planned features and fixes, including exact file paths and implementation notes for each item.
