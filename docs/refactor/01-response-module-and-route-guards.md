# Task 1 — Response construction module + route-ownership guard tests

> ## ✅ Landed 2026-08-10
>
> `src/lib/response.ts`, `src/routes.ts` and `test/assets.test.ts` are on `main`.
> `src/index.ts` went 93 → 39 lines; `api.ts` lost 231. Suite went 21 → 65 tests
> at the time of this task's merge.
>
> **Deliberate behaviour changes**, all three verified against `wrangler dev`:
> 1. Fragments gained `charset=utf-8` — the point of the task.
> 2. Responses that previously sent *no* `Cache-Control` now send `no-store`.
>    The `Cache` union has no "omit" member, and omission is not a policy. This
>    affects 404/500 pages and error fragments only.
> 3. Per-handler 404/500 copy ("Failed to load your posts") collapsed into the
>    generic `notFoundPage()` / `errorPage()` text.
>
> **Left for Task 2 on purpose:** `flags.ts` answers a malformed post id with
> **400** where `posts.ts` answers **404**. Unifying them is a behaviour
> decision, not response plumbing; there is a comment at the site.
>
> **Known rough edge:** `test/assets.test.ts` imports `node:fs` without
> `@types/node` installed, so editors show a squiggle. It does not affect
> `tsc --noEmit` (which excludes `test/`), the build, or the suite. Fix with
> `npm i -D @types/node`.

**Size:** Medium (mechanical, but touches every route file)
**Depends on:** nothing
**Risk:** Low — a missed conversion is visible in the diff

Two things are merged into one task because the guard tests require the route
table to be extracted from `src/index.ts`, and that extraction is the same edit
that makes centralised response construction natural.

---

## Problem

### Responses are built by hand 41 times

There are 41 hand-built `new Response(html, { headers: {...} })` sites across
`src/`. Of those, **29 write `"text/html"` and 12 write
`"text/html; charset=utf-8"`**. Cache-Control is chosen ad hoc per handler:
`public, max-age=300`, `public, max-age=3600`, `private, no-cache`, `no-store`,
and in some places omitted entirely.

Nothing enforces that a session-varying fragment is not cached publicly.
`handleComponentNavUser` gets this right by hand (`private, no-cache`), and the
next fragment handler someone adds has to remember to. The rule exists only in
the pattern of past code.

### Route ownership is stated in two places that can disagree

`wrangler.toml` currently declares:

```toml
run_worker_first = [ "/api/*", "/search", "/my-posts" ]
```

The router also owns `/conference/:slug`, `/subject/:slug` and `/post/:id` —
**none of which are listed.** They work today only because no Eleventy template
happens to build to those paths.

This is not hypothetical. It is exactly how `/search` broke:
`templates/pages/search.njk` built to `public/search/index.html`, Cloudflare
served the asset before invoking the Worker, and `handleSearch` never ran.
Re-adding `templates/pages/conference.njk` reproduces the outage silently.
`CLAUDE.md` calls this "the big footgun" and guards it with a paragraph of prose.

---

## Scope

1. Extract the route table out of `src/index.ts` into `src/routes.ts`, exporting
   a `ROUTES` array (or a `createRouter()` factory). `index.ts` keeps only the
   fetch handler, the trailing-slash redirect, and the asset fallthrough.
   This is also a prerequisite for Tasks 2 and 6.
2. Add `src/lib/response.ts`.
3. Move `notFoundPage()` / `forbiddenPage()` / `errorPage()` out of
   `src/routes/posts.ts`, where they are private to one file, into `lib/`.
   `api.ts` and `flags.ts` each hand-roll the same three pages today.
4. Convert all 41 response sites.
5. Add `test/assets.test.ts`.

---

## Proposed interface

```ts
// src/lib/response.ts

type Cache = 'public-short' | 'public-long' | 'private' | 'none';

export function htmlResponse(
  body: string,
  opts?: { status?: number; cache?: Cache },
): Response;

/** Wraps content in renderFullPage() and returns it. */
export function pageResponse(
  title: string,
  content: string,
  opts?: PageOptions & { status?: number; cache?: Cache },
): Response;

/** For /api/components/* — raw HTML fragment, no page chrome. */
export function fragmentResponse(
  html: string,
  opts?: { status?: number; cache?: Cache },
): Response;

export function notFoundPage(what?: string): Response;    // 404
export function forbiddenPage(reason?: string): Response; // 403
export function errorPage(): Response;                    // 500, generic text only
```

Design notes:

- **`charset=utf-8` becomes non-optional**, because it is written once.
- **`Cache` is a closed union**, so the policy is picked from a menu rather than
  retyped as a string. Map it to the concrete header value inside the module.
- **Default `pageResponse` to `'private'`.** Safe by default; opt in to public
  caching deliberately. Today the default is whatever the author typed.
- `errorPage()` must never interpolate an exception message. Round 2 fixed a
  case where D1 constraint and table names reached the client
  (`"Internal Server Error: " + err.message`); the module should make that
  mistake unexpressible.

---

## Guard tests — `test/assets.test.ts`

### Test A: no built asset shadows a registered route

For every route in `ROUTES`:

- **Literal paths** (`/search`, `/my-posts`): assert neither
  `public/<path>/index.html` nor `public/<path>.html` exists.
- **Param routes** (`/post/:id`, `/conference/:slug`, `/subject/:slug`): assert
  no directory exists at the literal prefix — `public/post/`,
  `public/conference/`, `public/subject/`.

### Test B: every route is covered by `run_worker_first`

Parse `run_worker_first` out of `wrangler.toml` and assert every route in
`ROUTES` is covered by at least one pattern.

**This will fail on first run.** That is the point — making it pass means adding
`/conference/*`, `/subject/*` and `/post/*` to `wrangler.toml`.

### Important caveat

Both tests read `public/`, which is a build output and is gitignored. Do **not**
let them silently pass when `public/` is absent — a guard test that no-ops in CI
is worse than no test. Either:

- gate them behind a `npm run check` script that runs `eleventy` first, or
- have the test invoke the build itself, or
- assert `public/` exists and fail loudly if it does not.

**As implemented:** the last option plus the first. Every assertion routes
through `requirePublicDir()`, which throws a pointed error naming `npm run check`
if `public/` is missing, and `npm run check` (`build && vitest run && tsc`) was
added to `package.json`.

Two implementation notes worth keeping:

- The tests had to move to a **second vitest project**. `vitest.config.mts` uses
  `defineWorkersConfig`, so everything ran inside workerd, which has no
  `node:fs`. It now declares a `workers` project and a `node` project; plain
  `npx vitest run` runs both.
- Test B's wildcard matching mirrors `generateGlobOnlyRuleRegExp()` from
  Cloudflare's own asset router (vendored in miniflare) rather than guessing:
  rules are anchored at both ends and `*` becomes `.*`, so `*` **does** cross
  `/` and `/post/*` genuinely covers `/post/1/edit`.

---

## Acceptance criteria

- [x] Zero occurrences of `"Content-Type": "text/html"` outside
      `src/lib/response.ts`. — verified: `grep -rn text/html src/` returns only
      that file.
- [x] `src/index.ts` is under ~40 lines; `ROUTES` is importable by tests. — 39
      lines; `test/assets.test.ts` imports `ROUTES` directly.
- [x] `notFoundPage` / `forbiddenPage` / `errorPage` live in `lib/` and are used
      by `api.ts`, `posts.ts` and `flags.ts`. — also `auth.ts`.
- [x] Both guard tests present and passing, with `wrangler.toml` corrected.
      Test B failed on first run for 6 routes, exactly as predicted;
      `/conference/*`, `/subject/*` and `/post/*` were added.
- [x] Guard tests fail loudly rather than skipping when `public/` is missing. —
      verified empirically by moving `public/` aside: 22 failures with the
      intended message, never a silent pass.
- [x] **Regression rehearsal** — stub `templates/pages/conference.njk` added and
      rebuilt: `Tests 1 failed | 64 passed`, failing with
      `public/conference/ exists and shadows the route /conference/:slug`.
      Removing the template *and* the stale `public/conference/` directory
      restored 65/65. Eleventy does not clean `public/`, so a deleted template
      leaves built output behind that still shadows the route — worth knowing.

---

## Verification

```bash
guix shell --container --emulate-fhs --network \
  node bash coreutils grep curl sed gawk findutils nss-certs \
  -- bash -c 'npm run build && npx vitest run && npx tsc --noEmit'
```

Then spot-check against `wrangler dev` that cache headers are unchanged on:
`/`, `/search`, `/my-posts`, `/api/components/nav-user` (must stay
`private, no-cache`), and `/api/components/nav-subjects` (public, long).
