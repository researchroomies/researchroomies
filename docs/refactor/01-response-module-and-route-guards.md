# Task 1 — Response construction module + route-ownership guard tests

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

---

## Acceptance criteria

- [ ] Zero occurrences of `"Content-Type": "text/html"` outside
      `src/lib/response.ts`.
- [ ] `src/index.ts` is under ~40 lines; `ROUTES` is importable by tests.
- [ ] `notFoundPage` / `forbiddenPage` / `errorPage` live in `lib/` and are used
      by `api.ts`, `posts.ts` and `flags.ts`.
- [ ] Both guard tests present and passing, with `wrangler.toml` corrected.
- [ ] Guard tests fail loudly rather than skipping when `public/` is missing.
- [ ] **Regression rehearsal:** add a stub `templates/pages/conference.njk`,
      confirm Test A fails, then remove it. Record the result in the PR.

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
