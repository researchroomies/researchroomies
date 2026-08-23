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
  - `create-post.ts` – writing a post: `POST /api/post`
  - `posts.ts` – changing your own post: edit, delete
  - `my-posts.ts` – `/my-posts`, the author's own listing
  - `messages.ts` – inquiry send
  - `auth.ts` – magic link login/logout/session
  - `flags.ts` – post reporting
- `src/db/` – every SQL statement, by table: `types` (every row shape), `posts`, `conferences`, `tags`, `share-types`, `positions`, `users`, `moderation`
- `src/lib/` – `config` (all deployment literals), `response` (every HTML response), `guards` (every session and ownership check), `shell.mjs` (the page chrome), `auth` (HMAC tokens), `session`, `turnstile`, `html`, `params`, `router`, `mailgun`, `share-types` (the picker/badge/option markup), `positions` (the author fields, their validation and the byline)
- `templates/style/style.css` – the only stylesheet: Classical tokens, then the
  system's component classes, then the application layer. No framework, no build
  step. See the styling section of AGENTS.md before touching it.
- `templates/pages/` – Eleventy (Nunjucks) page templates
- `templates/layouts/base.njk` – **generated** from `shell.mjs`; do not edit
- `migrations/` – D1 migrations, applied in `NNNN_` order; **the only definition of the database**

---

**The detailed "why" behind every feature and refactor task below — D1
migrations, share types, the all-conferences index, the Classical redesign,
position/institution, and all six refactor tasks — lives in
[`docs/history.md`](docs/history.md).** It was moved out of this file on
2026-08-23 because `CLAUDE.md` had grown to 67,684 characters, past the 40k
limit Claude Code loads it under. What remains here is present-state reference
material: current status, open decisions, backlog, and architecture notes.

**Keeping it that way:** when a feature or refactor lands, write the detailed
narrative — the reasoning, what was rejected and why, the verification steps —
into `docs/history.md`, not here. This file gets only the present-tense fact:
one line in Current State, a row in a table, or a bullet in Backlog/Architecture
Notes, with a link into `docs/history.md` if a reader might want the full story.
Run `wc -c CLAUDE.md` before committing a write-up to this file and keep it
comfortably under 40,000 — that's what broke last time.

---

## Current State — updated 2026-08-18

Eric Burkholder's first feedback round is fully implemented and the follow-up review of that work is closed out. **All six refactor tasks have landed** (see `docs/refactor/`, now closed).

Suite is **495 tests across 16 files** (373 across 12 at the close of the
refactor; share types, the all-conferences index, the redesign and the author
fields added the rest), up from 21 across 3 before it. `npm run build` and `tsc --noEmit` are clean. `npm run check` runs all three in the right order — build first, because the guard tests read `public/`.

### Feedback round 1 — all closed

| # | Item | Status |
|---|---|---|
| 1 | "My Posts" page | ✅ `GET /my-posts` |
| 2 | Search | ✅ Now actually reachable and filtering |
| 3 | Logout showed `{"ok":true}` | ✅ `HX-Redirect: /` |
| 4 | City/State instead of Location | ✅ stored as `"City, State"` in `location_address` |
| 5 | Duplicate-conference notice | ✅ plus real slug-collision handling |
| 6 | Pre-submit privacy disclaimer | ✅ |
| 7 | `.edu` email restriction | ✅ Enabled 2026-08-23 — `RESTRICT_EDU_EMAILS = "true"` |
| 8 | About page bio rewrite | ✅ |
| 9 | Conference list indentation | ✅ |
| 10 | Conference name + location + dates | ✅ + subject tags |
| — | Edit/delete own posts | ✅ `src/routes/posts.ts` |

---

## Open decisions

*(None outstanding. The `.edu` restriction, the only entry this section ever
held, was decided and turned on 2026-08-23 — see Architecture Notes below and
[`docs/history.md`](docs/history.md).)*

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
- **The `.edu` gate is ON.** `RESTRICT_EDU_EMAILS = "true"` in `wrangler.toml`; `isEmailAllowed()` in `src/lib/auth.ts` decides, and both `/api/auth/start` and `/api/auth/callback` apply it so a flip takes effect immediately rather than after in-flight links expire. `EDU_RESTRICTION_MESSAGE` (same file) is the single copy of the refusal text: `/api/auth/start` returns it as the **body of a 403** and `templates/pages/login.njk` shows that body verbatim in its dialog, which is why the static page needs no build-time knowledge of the flag. **403 is the page's signal** — do not add a second 403 to `handleAuthStart` or the wrong words appear in that dialog. It is a strict `.edu` suffix, so `.ac.uk` / `.edu.au` and any university without a `.edu` domain are refused, and it applies to existing users, not just signups. `test/edu-gate.test.ts` holds all of this.
- **`.dialog` in `templates/style/style.css` is the site's only modal**, a native `<dialog>` so the browser owns the focus trap, Esc-to-close and the backdrop. Only `/login` uses it today (the refusal notice and the mail-delivery notice), but it is a layer-2 system component, so reuse it rather than adding a second overlay.
- **Escaping:** Worker HTML is string-concatenated. Every interpolated DB or user value must pass through `escapeHtml()`.
- **Turnstile:** always verify with `verifyTurnstile()`; a missing token is a failure, never a skip.
- **Database:** D1 (SQLite), reached only through `src/db/` (above). Inside those modules: `env.DB.prepare(...).bind(...).first<T>()` / `.all<T>()` / `.run()` / `.batch([...])`, always `.bind()`, never string interpolation. Timestamps are Unix epoch seconds.
- **Local dev on Guix System:** `workerd` is a prebuilt ELF needing `/lib64/ld-linux-x86-64.so.2`, which does not exist on Guix. Anything that spawns it (`wrangler dev`, `wrangler d1 execute --local`, `vitest`) must run inside an FHS container — see the Testing section of `AGENTS.md`.
- **Never point local dev at real Mailgun.** `.dev.vars` holds a live key, and the login and report flows send to third parties. Stub it with `--var MAILGUN_API_BASE:http://127.0.0.1:8899/v3` and capture the multipart body locally; pair with Cloudflare's always-passing Turnstile test secret so forms submit without a browser. CLI `--var` overrides `.dev.vars`.
