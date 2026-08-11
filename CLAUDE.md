# ResearchRoomies – Agent Documentation

## Project Overview

ResearchRoomies is an academic conference travel cost–sharing platform. Academics post to find roommates, carpool partners, or other shared-expense arrangements for conferences.

**Stack:** Cloudflare Workers (TypeScript) + D1 (SQLite) + Eleventy (static pages) + HTMX

**Key files:**
- `src/index.ts` – Worker entry point: fetch handler, trailing-slash redirect, asset fallthrough. ~39 lines, no route list
- `src/routes.ts` – the `ROUTES` table + `createRouter()`; the single declaration of what the Worker owns
- `src/routes/api.ts` – Page renders + API handlers
- `src/routes/auth.ts` – Magic link login/logout/session
- `src/routes/posts.ts` – Author-only post edit/delete
- `src/routes/flags.ts` – Post reporting
- `src/lib/` – `config` (all deployment literals), `response` (every HTML response), `guards` (every session and ownership check), `shell.mjs` (the page chrome), `auth` (HMAC tokens), `session`, `turnstile`, `html`, `params`, `router`, `mailgun`
- `templates/pages/` – Eleventy (Nunjucks) page templates
- `templates/layouts/base.njk` – **generated** from `shell.mjs`; do not edit
- `db/schema.sql` – D1 schema (idempotent; safe to re-run)

---

## Current State — updated 2026-08-11

Eric Burkholder's first feedback round is fully implemented and the follow-up review of that work is closed out. **Refactor tasks 1, 2, 4 and 5 have since landed** (see `docs/refactor/`); tasks 3 and 6 remain.

Suite is **150 tests across 8 files**, up from 21 across 3 before the refactor. `npm run build` and `tsc --noEmit` are clean. `npm run check` runs all three in the right order — build first, because the guard tests read `public/`.

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

- **Refactor tasks 3 and 6 remain** — see `docs/refactor/`. Still a chain: 3 (repository module) → 6 (split `api.ts`), so there is no parallelism to exploit. Task 3 is the highest-leverage one and the only thing standing between the repo and handler tests.
- **The custom 404 page is probably never served.** `not_found_handling = "404-page"` looks for `public/404.html`, but Eleventy emits `public/404/index.html`. Found while verifying Task 4; not yet confirmed against production.
- **Worker pages are inconsistent about `description` / `canonicalUrl`.** `renderShell()` omits the meta and canonical tags when a handler passes nothing, which is the case for `/search`, `/my-posts` and the edit/delete/report pages. Task 4 fixed the shell and the nine static pages; this is the remaining half, and it is per-handler content rather than shell shape.
- **`test/assets.test.ts` imports `node:fs` with no `@types/node` installed**, so editors show a squiggle on the import. Harmless — `tsconfig.json` excludes `test/` and vitest does not typecheck — but `npm i -D @types/node` clears it.
- **`www.researchroomies.com` returns 522 for every path.** Only the apex is bound: `[[routes]]` in `wrangler.toml` has `pattern = "researchroomies.com"` with no `www` record or redirect. Found while diagnosing the search report; unrelated to search, but any inbound `www` link is currently dead.
- **Production `tags` drift from `db/schema.sql`.** Prod serves 5 tags with short slugs (`bio`, `chem`, `cs`, `math`, `physics`); the schema seeds 12 with long ones (`biology`, `chemistry`, `computer-science`, …). Re-running `db/schema.sql` against prod would *add* the 12 rather than reconcile, leaving a duplicated subject list. Decide which slug set is canonical and migrate before re-running the seed.
- **Subject filtering matches nothing on production.** `/search?tag=cs` returns 0 of 4 posts. Tags are only ever written in the "Create New Conference" branch of `handleCreatePost`, so conferences that predate the feature — or that were reused rather than created — can never be tagged, and there is no UI to tag one afterwards. Needs conference editing (below) to be fixable by users.
- **The homepage's featured-conference list is still HTMX-loaded.** `templates/pages/index.njk` fetches `/api/featured-conferences` on load, so crawlers see the homepage copy but none of the conference links. Smaller than the `/post/:id` case just fixed — the page has real content of its own and the same conferences are reachable from `/search` and `/subject/:slug` — but it is the last place where indexable links exist only after JS runs. Fixing it means either server-rendering `/` (it is currently a static asset) or accepting the gap.
- **`/api/components/post/:id` has no caller.** `templates/pages/post.njk` was its only consumer and is deleted; `/post/:id` is server-rendered. The route is kept registered on purpose so an old shell still cached in a browser degrades to a working page instead of a dead `hx-get`. It shares `getPostDetail()` / `renderPostDetail()` with `handlePostPage`, so it costs nothing to keep in sync. Safe to delete once the cache window has passed — assets are served with Cloudflare's defaults and the HTML shell is long gone from `public/`, so a few weeks is generous. Deleting it means removing the handler, its entry in `ROUTES` (`src/routes.ts`), and the row in the AGENTS.md route table. `test/assets.test.ts` reads `ROUTES`, so nothing else needs updating.
- **Post creation is not atomic (known limit).** Creating a post against a *new* conference is three separate writes: conference insert, tag batch, post insert. If the post insert fails, the conference survives as an orphan and holds its slug, so the user's retry gets `-2` appended to it. `batch()` cannot fix this — the post insert needs the id the conference insert `RETURNING`s, and `batch()` has no way to pipe one statement's output into the next. A real fix needs either a different API shape or a periodic sweep of conferences with zero posts. Noted in a comment at the top of the `conferenceId === "new"` branch in `handleCreatePost`.
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
- **Deployment literals live in `src/lib/config.ts`.** `getConfig(env, request?)` is the only place an origin, TTL, sitekey, Mailgun setting or admin address is defined. The session TTL in particular has exactly one definition feeding both the cookie `Max-Age` and the token `exp` — they were two independent constants agreeing by coincidence, and divergence is a silent logout.
- **Route ids:** parse with `parseRouteId()` from `src/lib/params.ts`, never bare `parseInt()`. `parseInt("12abc", 10)` is `12` and passes `Number.isFinite()`, which silently turns a malformed URL into a lookup of a different row.
- **Handler order:** check the session *before* querying anything keyed on a user-supplied id. Querying first leaks row existence through the status code to callers who are not allowed to see it. The guards do this by construction.
- **HTMX pattern:** `/api/components/*` return raw HTML fragments, not JSON.
- **Session auth: one entry point, `src/lib/guards.ts`.** Cookie-based signed tokens, no DB lookup per request. `requireUser(request, env, mode)` for anything that needs a user, `optionalUser()` where anonymous is fine, `requireOwnedPost()` for the post edit/delete family. Never call `getSessionUser()` from a handler — `test/session-access.test.ts` fails the build if you do. The three failure modes (`'page'` 302, `'api'` 401, `'htmx'` 200 + `HX-Redirect`) are documented on the `GuardMode` type and nowhere else; that folklore living in ten handlers instead is what the task fixed. Never trust an id from a form body — `requireOwnedPost()` re-checks ownership against the DB row.
- **Escaping:** Worker HTML is string-concatenated. Every interpolated DB or user value must pass through `escapeHtml()`.
- **Turnstile:** always verify with `verifyTurnstile()`; a missing token is a failure, never a skip.
- **Database:** D1 (SQLite). `env.DB.prepare(...).bind(...).first()` / `.all()` / `.run()` / `.batch([...])`. Timestamps are Unix epoch seconds.
- **Local dev on Guix System:** `workerd` is a prebuilt ELF needing `/lib64/ld-linux-x86-64.so.2`, which does not exist on Guix. Anything that spawns it (`wrangler dev`, `wrangler d1 execute --local`, `vitest`) must run inside an FHS container — see the Testing section of `AGENTS.md`.
- **Never point local dev at real Mailgun.** `.dev.vars` holds a live key, and the login and report flows send to third parties. Stub it with `--var MAILGUN_API_BASE:http://127.0.0.1:8899/v3` and capture the multipart body locally; pair with Cloudflare's always-passing Turnstile test secret so forms submit without a browser. CLI `--var` overrides `.dev.vars`.
