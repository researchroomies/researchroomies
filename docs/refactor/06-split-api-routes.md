# Task 6 — Split `src/routes/api.ts`

**Size:** Small once Tasks 1–3 have landed; large before
**Depends on:** Tasks 1 (✅ landed 2026-08-10), 2 and 3 — **hard dependency**
**Risk:** Low if it stays a pure move

**Do this last. It is a consequence of Tasks 1–3, not a substitute for them.**

> **Still blocked.** Task 1 landing does not unblock this — Tasks 2 and 3 are
> the ones that shrink the handlers, and splitting before them produces
> ~300-line files with the same interface surface. Step 1 of Verification below
> now reads `ROUTES` in `src/routes.ts`, which Task 1 created.

---

## Problem

`src/routes/api.ts` was 1,199 lines at review and is **1,079** after Task 1 —
**37% of all TypeScript in `src/`**, down from 43%, and still the largest file in
the repo by a wide margin. It exports 14 handlers spanning six unrelated
concerns:

- conference pages (`handleConferencePage`, `handleFeaturedConferences`)
- tag / subject browsing (`handleSubjectPage`)
- HTMX component fragments (six `/api/components/*` handlers)
- post creation and the post page (`handleCreatePost`, `handlePostPage`)
- inquiry messaging (`handleMessageSend`)
- search (`handleSearch`)

It also contains five data-access functions, `generateSlug` /
`generateUniqueSlug`, and `escapeLike`.

---

## Why this is sequenced last

Splitting a 1,000-plus-line file changes nothing about depth if the handlers keep
their current shape. Done first, it produces four ~300-line files with the same
interface surface and the same inline SQL — motion without leverage. Task 1
already removed the hand-built responses, and it moved the total by 120 lines;
the remaining bulk is SQL and rendering, which is Task 3's subject.

It also actively harms the review of Tasks 1–3, whose diffs would then land
across files that had just moved, making it hard to tell a behaviour change from
a relocation.

After Tasks 1–3, each handler reduces to roughly *guard → repository call →
`pageResponse(...)`*. `api.ts` should land near 400 lines on its own, and the
seams stop being arbitrary — they follow the `src/db/` modules that already
exist by then.

---

## Proposed split

Revisit this after Tasks 1–3; the natural lines may have moved.

| File | Contents |
|---|---|
| `routes/conferences.ts` | `handleConferencePage`, `handleFeaturedConferences` |
| `routes/subjects.ts` | `handleSubjectPage` |
| `routes/search.ts` | `handleSearch` |
| `routes/components.ts` | the six `/api/components/*` fragment handlers |
| `routes/posts.ts` | absorbs `handleCreatePost` and `handlePostPage` — they belong with edit / delete |
| `routes/messages.ts` | `handleMessageSend` |

Helpers relocate rather than move sideways:

- `generateSlug` / `generateUniqueSlug` → `src/db/conferences.ts` as
  `reserveSlug` (Task 3)
- `escapeLike` → inside the `searchPosts` filter builder in `src/db/posts.ts`
  (Task 3)
- `renderTagChips`, `renderFeaturedConferences`, `renderConferencePage` → keep
  them private to whichever route module uses them; do not create a shared
  `render.ts` grab bag, which would just recreate the problem at a smaller scale

---

## Acceptance criteria

- [ ] No file in `src/routes/` exceeds ~300 lines.
- [ ] Every route file imports from `src/lib/` and `src/db/` only. **No route
      file imports another route file** — if one needs to, the shared thing
      belongs in `lib/` or `db/`.
- [ ] `src/routes.ts` (created in Task 1) remains the only place that knows the
      full route list.
- [ ] **No behaviour change.** This should be a pure move.

---

## Verification

Because this is a pure move, verification is a diff rather than a test:

1. With `wrangler dev` running, capture responses for every route in
   `src/routes.ts` before the change.
2. Capture them again after.
3. They should be byte-identical apart from any timestamp in the footer.

Resist the urge to fix anything mid-split. If you find a defect while moving
code, note it and open a separate change — a bug fix hidden inside a 1,200-line
file move is unreviewable.
