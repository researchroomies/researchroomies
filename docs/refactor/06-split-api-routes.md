# Task 6 — Split `src/routes/api.ts`

> ## ✅ Landed 2026-08-12
>
> `src/routes/api.ts` is **deleted**. Its 804 lines are now seven modules by
> concern, the largest of which is `posts.ts` at 303 lines. All four acceptance
> criteria are met — see the checklist at the bottom.
>
> It is a **pure move**: all 23 functions across the old `api.ts` and `posts.ts`
> are byte-identical in their new homes, and the `ROUTES` array in
> `src/routes.ts` is unchanged (only its import block moved). See
> **Verification** for how that was established.
>
> Two deviations from the proposed split, both forced by the acceptance
> criteria themselves, are recorded in **Deviations from the plan**.
>
> Written up in CLAUDE.md under "Refactor Task 6". This closes `docs/refactor/`.

**Size:** Small once Tasks 1–3 have landed; large before
**Depends on:** Tasks 1 (✅ 2026-08-10), 2 (✅ 2026-08-11) and 3 (✅ 2026-08-12) —
**all satisfied**
**Risk:** Low if it stays a pure move

**Do this last. It is a consequence of Tasks 1–3, not a substitute for them.**

---

## Problem

`src/routes/api.ts` was 1,199 lines at review, 1,079 after Task 1 and **804**
after Task 3 — still the largest file in the repo by a wide margin, and 25% of
all TypeScript in `src/`. It exported 14 handlers spanning six unrelated
concerns:

- conference pages (`handleConferencePage`, `handleFeaturedConferences`)
- tag / subject browsing (`handleSubjectPage`)
- HTMX component fragments (six `/api/components/*` handlers)
- post creation and the post page (`handleCreatePost`, `handlePostPage`)
- inquiry messaging (`handleMessageSend`)
- search (`handleSearch`)

---

## Why this was sequenced last

Splitting a 1,000-plus-line file changes nothing about depth if the handlers
keep their current shape. Done first, it would have produced four ~300-line
files with the same interface surface and the same inline SQL — motion without
leverage. Task 1 removed the hand-built responses; Task 3 removed the SQL. What
was left by the time this ran was guard → repository call → `pageResponse(...)`,
and the seams stopped being arbitrary: they follow the `src/db/` modules.

It would also have actively harmed the review of Tasks 1–3, whose diffs would
have landed across files that had just moved, making a behaviour change hard to
tell from a relocation.

---

## The split as it landed

| File | Lines | Contents |
|---|---|---|
| `routes/posts.ts` | 303 | `handleCreatePost`, `handleMyPosts`, and the four edit/delete handlers already there |
| `routes/post-detail.ts` | 172 | `handlePostPage`, `handleComponentPost`, `renderPostDetail` |
| `routes/conferences.ts` | 146 | `handleConferencePage`, `handleFeaturedConferences`, and their three render helpers |
| `routes/components.ts` | 130 | five `/api/components/*` fragment handlers |
| `routes/search.ts` | 102 | `handleSearch`, `dateParamToTimestamp` |
| `routes/messages.ts` | 85 | `handleMessageSend` |
| `routes/subjects.ts` | 63 | `handleSubjectPage` |

`routes/auth.ts` (194) and `routes/flags.ts` (170) were not touched.

The render helpers stayed private to the module that uses them, as planned. No
shared `render.ts` was created — that would have recreated `api.ts` at a smaller
scale, and the no-cross-import rule below is what makes the temptation visible.

---

## Deviations from the plan

Both come from the same collision: the proposed table put
`handleComponentPost` in `components.ts` and `handlePostPage` in `posts.ts`, but
those two handlers **share `renderPostDetail()`**. Honouring that table would
have forced either a route-to-route import or a shared render grab bag, each
banned by an acceptance criterion.

1. **`post-detail.ts` exists; it was not in the proposed table.** `/post/:id`
   and `/api/components/post/:id` are one rendering with two envelopes, so they
   live together and `renderPostDetail()` stays private. This also makes the
   backlog item "delete the component route once the cache window has passed" a
   single-file change.
2. **`posts.ts` absorbed `handleCreatePost` and `handleMyPosts` but not
   `handlePostPage`.** The seam that fell out is *authoring* (needs a session,
   acts on your own posts) versus *reading* (renders for anonymous viewers).
   Putting all of it in one file would also have pushed `posts.ts` past 440
   lines, breaking the ~300 criterion.

`handleMyPosts` had no destination in the proposed table at all; it went to
`posts.ts` on the authoring/reading seam above.

---

## Acceptance criteria

- [x] No file in `src/routes/` exceeds ~300 lines. Largest is `posts.ts` at 303;
      `test/route-modules.test.ts` enforces a 320-line bound.
- [x] Every route file imports from `src/lib/` and `src/db/` only. **No route
      file imports another route file** — enforced by test, not prose.
- [x] `src/routes.ts` remains the only place that knows the full route list. Its
      `ROUTES` array is byte-identical; only the import block changed.
- [x] **No behaviour change.** Pure move, verified below.

---

## Verification

The plan called for diffing `wrangler dev` responses before and after. What was
done instead is strictly stronger for a pure move, because it compares the code
rather than a sample of its output:

1. **Every function is byte-identical.** A script extracted all 23 top-level
   functions from the pre-change `api.ts` and `posts.ts` and from the seven
   post-change modules, and compared them by exact text. All 23 matched, each
   landing in exactly one destination, with no function invented and none lost.
2. **The route table is unchanged.** `git diff src/routes.ts` touches only the
   import block. Since handler names are unaltered (1), every path → handler
   binding is provably the same.
3. **The suite passes**, including the handler and search tests that run against
   a real D1: **373 tests across 12 files**, up from 299 across 11. `npm run
   build` and `tsc --noEmit` are clean.

(1) and (2) together leave no room for a response to differ, which is why the
live diff was not also run — it could only have sampled what was already proven.
The harness for (1) was deleted rather than kept; it has nothing to say about
any future change.

**The new guard test was checked against mutation**, as the earlier tasks'
were. Adding a sibling import to `subjects.ts` fails criterion A; padding a
module past the bound fails B; deleting a `ROUTES` row for a still-exported
handler fails C.

---

## What this leaves

`docs/refactor/` is closed — all six tasks have landed. The remaining known
issues are in the CLAUDE.md backlog and are product or operational questions
(production tag drift, `www` binding, conference editing, moderation review),
not structural ones.
