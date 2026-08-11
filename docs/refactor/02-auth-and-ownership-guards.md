# Task 2 — Auth and ownership guards

**Size:** Medium
**Depends on:** Task 1 — ✅ **landed 2026-08-10, so this is ready to start.**
`notFoundPage()` / `forbiddenPage()` / `errorPage()` are in `src/lib/response.ts`
now; import them rather than inlining anything.
**Risk:** Low–medium — verify each converted handler keeps its original failure
mode; a silent change from 302 to 401 breaks the HTMX flows

> **What Task 1 changed under this task's feet:**
> - Routes moved from `src/index.ts` to the `ROUTES` array in `src/routes.ts`.
> - Handler bodies are shorter; failure branches now return `pageResponse(...)`
>   or the three shared error pages instead of hand-built `new Response`.
> - The 15 `getSessionUser()` call sites are now 14 — the count moved for
>   unrelated reasons, so re-measure before trusting the table below.
> - **One inconsistency was left here deliberately:** `flags.ts` answers a
>   malformed post id with **400**, `posts.ts` with **404**. Task 1 preserved
>   both rather than picking one, because that is a behaviour decision. Pick one
>   here and say which in the PR.
> - Bare-text failures (`new Response('Unauthorized', { status: 401 })`) were
>   *not* converted by Task 1 — converting them changes the wire format, and
>   their shape is exactly what this task is about.

---

## Problem

### One condition, three different answers

There are 15 `getSessionUser()` call sites, each followed by a hand-written
failure branch. They implement **three mutually inconsistent behaviours** for the
same condition:

| Failure mode | Where |
|---|---|
| `302 → /login` | `posts.ts` ×4, `flags.ts` (report form), `api.ts` (`handleMyPosts`) |
| `401 "Unauthorized"` plain text | `api.ts` (`handleCreatePost`, `handleMessageSend`), `flags.ts` (report submit) |
| `200` + `HX-Redirect: /login` | `api.ts` (`handleComponentCreateFormAuth`) |

There is a defensible reason for each — a page navigation should redirect, a
form POST should refuse, an HTMX fragment needs `HX-Redirect` because the browser
will not follow a 302 inside a swap. But that rule is written down nowhere and
lives inconsistently in the code, so a new handler picks one at random.

### Ownership checking is a ritual, not a module

In `src/routes/posts.ts` the same three steps repeat four times: fetch the post
→ compare `user_id` against the session → return `forbiddenPage()`. Each
repetition is an opportunity to forget step 2. The rule that matters —
*never trust an id from a form body; re-check ownership against the DB row on
every mutating request* — is currently enforced by remembering to type it out.

### The login route bypasses the Turnstile seam

`src/routes/auth.ts` still hand-rolls its own siteverify `fetch` instead of
calling `verifyTurnstile()` from `src/lib/turnstile.ts`.

`lib/turnstile.ts` exists specifically to make *"a missing token is a failure,
not a skip"* unforgettable — that exact bug shipped once already, where handlers
guarded verification with `if (token) { verify }` and anything omitting the field
sailed through. The login route, where a bypass matters most, routes around the
module that encodes the fix.

---

## Scope

Add `src/lib/guards.ts`; apply across `api.ts`, `posts.ts`, `flags.ts`. Plus the
one-line `routes/auth.ts` change to call `verifyTurnstile()`.

---

## Proposed interface

```ts
// src/lib/guards.ts

type Guard<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * `mode` decides the failure shape:
 *   'page' → 302 to /login          (full page navigations)
 *   'api'  → 401 plain text          (form POSTs and JSON endpoints)
 *   'htmx' → 200 + HX-Redirect       (fragments swapped into a live page;
 *                                     the browser will not follow a 302 here)
 */
export async function requireUser(
  request: Request,
  env: Env,
  mode: 'page' | 'api' | 'htmx',
): Promise<Guard<SessionPayload>>;

/** Session + id parse + row fetch + ownership check, in one call. */
export async function requireOwnedPost(
  request: Request,
  env: Env,
  params: Record<string, string> | undefined,
): Promise<Guard<{ user: SessionPayload; post: PostRow }>>;
```

Call sites become:

```ts
const g = await requireOwnedPost(request, env, params);
if (!g.ok) return g.response;
const { user, post } = g.value;
```

Design notes:

- **The discriminated union is deliberate, over throwing.** It keeps the failure
  `Response` an ordinary value the handler returns, so control flow stays visible
  and there is no exception path anyone has to remember to catch. It also means
  the guards need no knowledge of the surrounding `try`/`catch`.
- **`requireOwnedPost` folds in `parseRouteId()`** (already in
  `src/lib/params.ts`) and the `notFoundPage()` / `forbiddenPage()` responses.
  This collapses roughly 20 lines per handler down to 2.
- **Document the three modes on the `mode` parameter itself.** The whole point
  of the task is that the rule stops being folklore.
- Keep the "defence in depth" `AND user_id = ?` clause on the `UPDATE`/`DELETE`
  statements in `posts.ts`. The guard makes it redundant, not wrong.

---

## Acceptance criteria

- [ ] `getSessionUser()` is called only from `src/lib/guards.ts` and
      `src/routes/auth.ts` (`handleAuthMe`).
- [ ] The three failure modes are documented in exactly one place — on
      `requireUser`'s `mode` parameter.
- [ ] No handler in `src/routes/posts.ts` contains an explicit
      `post.user_id !== sessionUserId(user)` comparison.
- [ ] `src/routes/auth.ts` contains no `siteverify` string and no inline
      Turnstile `FormData`.
- [ ] Unit tests for `requireUser` across all three modes × (no cookie /
      malformed token / expired token / valid token). These are trivial to
      write — the function takes a `Request` and returns a value.
- [ ] Every converted handler keeps its original failure mode. Enumerate them in
      the PR description against the table above.

---

## Verification

The failure-mode table is the risk. Check by hand against `wrangler dev`, logged
out, that each of these still behaves as it does today:

| Request | Expected |
|---|---|
| `GET /my-posts` | 302 → `/login` |
| `GET /post/1/edit` | 302 → `/login` |
| `POST /api/post` | 401 |
| `POST /api/message/send` | 401 |
| `POST /post/1/report` | 401 |
| `GET /api/components/create-form-auth` | 200 + `HX-Redirect: /login` |

Then log in and confirm `/post/:id/edit` on someone else's post still returns
403 with the rendered Forbidden page, not a 404 or a 500.
