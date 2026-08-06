# ResearchRoomies – Agent Documentation

## Project Overview

ResearchRoomies is an academic conference travel cost–sharing platform. Academics post to find roommates, carpool partners, or other shared-expense arrangements for conferences.

**Stack:** Cloudflare Workers (TypeScript) + D1 (SQLite) + Eleventy (static pages) + HTMX

**Key files:**
- `src/index.ts` – Worker entry point, route registration
- `src/routes/api.ts` – Page renders + API handlers
- `src/routes/auth.ts` – Magic link login/logout/session
- `src/routes/posts.ts` – Author-only post edit/delete
- `src/routes/flags.ts` – Post reporting
- `src/lib/` – `auth` (HMAC tokens), `session`, `turnstile`, `html`, `router`, `mailgun`
- `templates/pages/` – Eleventy (Nunjucks) page templates
- `db/schema.sql` – D1 schema (idempotent; safe to re-run)

---

## Current State — updated 2026-08-04

Eric Burkholder's first feedback round is fully implemented, and the follow-up review of that work has been closed out. Verified with 72 end-to-end assertions against `wrangler dev` plus the unit suite; `tsc --noEmit` and `npm run build` are clean.

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
- **Turnstile was inert.** The client script only loaded on `/login`, so create-post and inquiry forms never produced a token — and both handlers used `if (token) { verify }`, silently skipping the check. The script is now in `base.njk` and `renderFullPage()`, and `verifyTurnstile()` in `src/lib/turnstile.ts` treats a missing token as failure.
- **Stored XSS.** Post titles, descriptions, conference names, locations, and page titles were interpolated raw. Everything now goes through `escapeHtml()` from `src/lib/html.ts`.
- **Nav login state on Worker-rendered pages.** `renderFullPage()` was a drifted copy of `base.njk` missing `#nav-user-state`. Both now render the same nav, with user state and subject links as HTMX fragments.
- **Conference slug collisions.** `generateUniqueSlug()` suffixes duplicates (`-2`, `-3`), backed by a `UNIQUE` index.
- **Dead surface built out.** Subject tags (curated seed list, conference-level, browsable at `/subject/:slug`), post reporting into `flags` with an admin email, and inquiry persistence into `message`.
- **Deploy safety.** `npm run deploy` is now `npm run build && wrangler deploy`; it previously shipped whatever stale HTML was in `public/`.

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

- **Moderation review.** `flags` rows are written and emailed to `admin@researchroomies.com`, but there is no in-app review UI. That needs an admin concept (`users.is_admin` or similar), which the schema does not have.
- **Structured locations.** `countries` / `states` / `cities` and `conferences.city_id` remain intentionally dormant; city/state are free text. Revisit if location-based search is wanted.
- **Editing conference details.** Posts are editable; the conference a post belongs to is not.
- **`message` is write-only.** Rows are recorded but never surfaced anywhere.
- **Inquiry persistence depends on email success.** `handleMessageSend` inserts the `message` row only after Mailgun accepts, so a Mailgun outage returns 500 and records nothing. Deliberate for now (the row means "this was actually sent"), but worth revisiting.
- **`APP_ORIGIN` in `src/routes/auth.ts` is hardcoded to production**, so magic links generated in local dev point at researchroomies.com.
- **npm audit reports 6 high advisories**, all dev-only (`wrangler`/`miniflare` → `sharp`, `ws`, `undici`); nothing reaches the edge, since Workers bundles only `src/`. There is currently no clean path to zero: `@cloudflare/vitest-pool-workers` ≥ 0.16.8 requires vitest 4, and 0.20.x drops the `./config` export `vitest.config.mts` imports, so upgrading needs a config migration. npm's own suggested "fix" is a downgrade into differently-vulnerable versions. Re-check when Cloudflare ships a clean combination.

---

## Architecture Notes

- **Asset routing precedence (the big footgun).** Cloudflare serves a matching static asset *before* invoking the Worker. Adding `templates/pages/foo.njk` will silently shadow a `GET /foo` Worker route — this is exactly how `/search` broke. Either don't create the template, or add the path to `run_worker_first` in `wrangler.toml`.
- **Static vs. dynamic rendering:** pages in `templates/pages/` are built by Eleventy at deploy time; dynamic content is Worker-rendered or injected via HTMX. `renderFullPage()` in `src/lib/html.ts` is the server-side twin of `templates/layouts/base.njk` — **change both together.**
- **HTMX pattern:** `/api/components/*` return raw HTML fragments, not JSON.
- **Session auth:** cookie-based signed tokens, no DB lookup per request. Use `getSessionUser(request, env)` from `src/lib/session.ts`; `sessionUserId(user)` gives the numeric `users.id`. Never trust an id from a form body — re-check ownership against the DB row on every mutating request.
- **Escaping:** Worker HTML is string-concatenated. Every interpolated DB or user value must pass through `escapeHtml()`.
- **Turnstile:** always verify with `verifyTurnstile()`; a missing token is a failure, never a skip.
- **Database:** D1 (SQLite). `env.DB.prepare(...).bind(...).first()` / `.all()` / `.run()` / `.batch([...])`. Timestamps are Unix epoch seconds.
- **Local dev on Guix System:** `workerd` is a prebuilt ELF needing `/lib64/ld-linux-x86-64.so.2`, which does not exist on Guix. Anything that spawns it (`wrangler dev`, `wrangler d1 execute --local`, `vitest`) must run inside an FHS container — see the Testing section of `AGENTS.md`.
