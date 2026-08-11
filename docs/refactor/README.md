# Refactor backlog

Architecture review of ResearchRoomies, 2026-08-10, evaluated against **depth**
(behaviour per unit of interface), **seam placement**, and **testability**.

Each file in this directory is a self-contained, individually assignable task.
Dependencies between them are stated explicitly; where none is listed, the task
can be picked up cold.

---

## Verdict

`src/lib/` is well designed. `mailgun.ts`, `turnstile.ts`, `session.ts` and
`auth.ts` are genuinely deep modules — small interfaces over real behaviour.
`sendInquiryEmail(author, sender, title, content, env)` hands the caller five
domain values and hides Mailgun auth, form encoding, From-address resolution and
error handling. That is the model the rest of the codebase should follow.

The problem is that `src/routes/` does not follow it for anything except email
and Turnstile. **There is no seam between HTTP handling, data access, and HTML
rendering.** Every handler does all three inline, so the interface you must learn
in order to add one feature is the whole system: the SQL schema, the escaping
rule, the cache-control convention, the error-page convention, the redirect
convention, the Turnstile convention.

That single missing seam explains nearly every item below, including why there
are no handler tests.

---

## Measured state

"At review" is the working tree on 2026-08-10 when this backlog was written,
after the Round 2 hardening pass described in `CLAUDE.md`. "Now" is the same
measurement after Tasks 1, 4 and 5 landed on `main` that day and Task 2 landed
on 2026-08-11.

| Metric | At review | Now | Closed by |
|---|---|---|---|
| `src/routes/api.ts` | 1,199 lines | **1,074** | partially Tasks 1–2; Task 6 is the real fix |
| `renderFullPage()` call sites | 29 | **1** (`pageResponse`) | Task 1 |
| `try {` blocks in `src/` | 24 | 24 | Task 3 territory |
| `"text/html"` vs `"text/html; charset=utf-8"` | 29 / 12 | **0 / 1**, inside `response.ts` | Task 1 |
| `getSessionUser()` call sites | 15 | **3** (2 in `guards.ts`, 1 in `handleAuthMe`) | Task 2 |
| `DB.prepare()` call sites | 30 | 24 | **Task 3** |
| Turnstile sitekey literals | 4 | **0** in `src/`+`templates/`, 1 in `wrangler.toml` | Task 5 |
| `SESSION_TTL` definitions | 2 | **1** | Task 5 |
| Hand-built HTML `new Response` | 41 | **0** | Task 1 |
| Inline ownership comparisons | 4 | **0** (`requireOwnedPost`) | Task 2 |
| `src/routes/posts.ts` | 258 lines | **140** | Task 2 |
| Handler tests | 0 | 0 | **Task 3** |
| Test count | 21 across 3 files | **150 across 8 files** | Tasks 1, 2, 4, 5 |

`src/` is ~2,900 lines of TypeScript. `api.ts` alone is 37% of it — down from
43%, but still the largest file by a wide margin.

The 33 remaining `new Response(...)` sites are bare-text 4xx/405s, redirects and
the two JSON endpoints in `auth.ts`. Task 2 converted the auth failures among
them into `requireUser()`'s three documented modes; what is left is request-body
validation (`Missing required fields`), `405`s, and the JSON endpoints, whose
wire format is deliberately unchanged.

---

## Duplication inventory

Sites are as measured at review. ✅ marks duplication that has since been closed.

| Repeated thing | Sites | Consequence | Status |
|---|---|---|---|
| `env.DB.prepare(...)` with inline SQL | 30 | Row shapes redeclared 6+ ways. No single definition of "a Post". | open → Task 3 |
| `getSessionUser()` + failure branch | 15 | Three inconsistent failure modes for the same condition. | open → Task 2 |
| Hand-built `new Response(html, {headers})` | 41 | Charset written two ways; cache policy chosen ad hoc. | ✅ Task 1 |
| `try { ... } catch` per handler | 24 | Error response shape re-decided each time. | partly ✅ — the *response* is now `errorPage()`; the blocks remain |
| Turnstile sitekey `0x4AAA…` | 4 (2 TS, 2 njk) | Rotating the widget means 4 edits across two languages. | ✅ Task 5 |
| `SESSION_TTL = 30 days` | 2 files | Cookie `Max-Age` and token `exp` independently defined. | ✅ Task 5 |
| `escapeHtml` | 2 (`html.ts`, `mailgun.ts`) | `escapeHtmlForEmail` is a byte-identical copy. | open — see below |

Near-identical `SELECT posts JOIN conferences` appears in `handleComponentPost`,
`handleEditPostForm` and `handleReportForm` with slightly different column lists.

**On `escapeHtml`:** Task 4 moved the canonical copy into `src/lib/shell.mjs`
(the shell needs escaping and cannot import TypeScript) and `html.ts` now
re-exports it, so that pair is one definition reached by two paths.
`escapeHtmlForEmail` in `mailgun.ts` is still a separate copy and is still
justified — email HTML and page HTML have different escaping requirements and
merging them would couple two things that should be free to diverge.

---

## Invariants that were maintained by documentation instead of code

These are the fragile ones. Each has either broken already or can break
silently. Three of the four are now guarded by a test rather than a paragraph.

1. ✅ **`renderFullPage()` ⟷ `base.njk`.** Was "change both together" in
   `CLAUDE.md` — that instruction *was* the seam. Both now come from
   `renderShell()` and `test/shell.test.ts` diffs them byte for byte.
   → [Task 4](04-single-page-shell.md), landed

2. ✅ **`run_worker_first` ⟷ the route table.** `wrangler.toml` restated by
   hand which paths the Worker owns and was missing three of them.
   `test/assets.test.ts` now reads `ROUTES` and fails if any route is
   uncovered or shadowed by a built asset.
   → [Task 1](01-response-module-and-route-guards.md), landed

3. ✅ **Turnstile always goes through `verifyTurnstile()`.** `src/routes/auth.ts`
   hand-rolled its own siteverify call and ignored the module.
   `test/session-access.test.ts` now fails on the string `siteverify` anywhere
   outside `lib/turnstile.ts`.
   → [Task 2](02-auth-and-ownership-guards.md), landed

4. ⬜ **Every interpolated value passes `escapeHtml()`.** Currently held
   everywhere — Round 2 closed the last gap in `sendInquiryEmail`. Nothing
   enforces it beyond review, but string-concatenated HTML makes this hard to
   fix structurally; noted rather than assigned.

5. ⬜ **The sitekey in `[vars]` ⟷ the Eleventy build.** New with Task 5, and
   guarded by construction rather than by a test: `eleventy.config.js` reads
   `TURNSTILE_SITE_KEY` out of `wrangler.toml` and throws if it is absent, and
   `npm run deploy` builds first — so a missing sitekey fails the deploy instead
   of shipping a dead widget.

---

## Testability

At review there were 190 lines of tests, all against pure functions: `Router`,
token crypto, `isEmailAllowed`, `parseRouteId`. Tasks 1, 2, 4 and 5 took the
suite from **21 tests across 3 files to 150 across 8**, adding four kinds of test
the repo did not have:

- **Structural guards** (`assets.test.ts`) — reads `ROUTES` and asserts no built
  asset shadows a route and `run_worker_first` covers every one. Runs in plain
  node, not workerd, because it needs `node:fs`.
- **Source greps as invariants** (`session-access.test.ts`) — no `getSessionUser`
  outside `lib/guards.ts`, no inline ownership comparison in `posts.ts`, no
  `siteverify` outside `lib/turnstile.ts`. Comments are stripped first, so the
  comment explaining a rule cannot trip it. Also node-only.
- **Failure-shape matrices** (`guards.test.ts`) — `requireUser` across all three
  modes against every way a session can be absent (no cookie, no session cookie,
  malformed, forged, expired), asserting the exact status, `Location` and
  `HX-Redirect` of each refusal. This is where the three-answers-to-one-question
  problem would come back.
- **Byte-diff of two renderers** (`shell.test.ts`) — the committed `base.njk`
  against `renderFullPage()`, head, footer and whole document.
- **Config defaults as assertions** (`config.test.ts`) — each default pins the
  literal it replaced, so "invisible in production" is checkable, plus the
  cookie `Max-Age` ⟷ token `exp - iat` agreement.

**There are still no handler tests.** That is not a discipline gap — it is a
consequence of the shape. A handler takes `(Request, Env, ExecutionContext)` and
reaches straight into `env.DB` with raw SQL, so exercising one requires a real
database and a real HTTP round trip. Task 2's failure-mode table was verified
that way — by hand against `wrangler dev` with a seeded local D1 and minted
session cookies — and those assertions, like the 72 from the earlier review
round, do not survive as tests.

`@cloudflare/vitest-pool-workers` is configured and provides a real D1 in
process, and nothing uses it. [Task 3](03-repository-module.md) is what makes
handler tests possible without it.

**Two vitest projects now.** `vitest.config.mts` declares a `workers` project and
a `node` project; `npx vitest run` runs both. Anything added that needs `node:fs`
belongs in the node project — do not narrow the default run to one of them.

---

## Tasks

| # | Task | Size | Depends on | Status |
|---|---|---|---|---|
| 1 | [Response module + route-ownership guard tests](01-response-module-and-route-guards.md) | Medium | — | ✅ landed 2026-08-10 |
| 2 | [Auth and ownership guards](02-auth-and-ownership-guards.md) | Medium | 1 | ✅ landed 2026-08-11 |
| 3 | [Repository module](03-repository-module.md) | Large | 1, 2 (soft) | ⬜ ready — both satisfied |
| 4 | [Collapse the two page shells](04-single-page-shell.md) | Small–medium | — | ✅ landed 2026-08-10 |
| 5 | [Configuration module](05-config-module.md) | Small | — | ✅ landed 2026-08-10 |
| 6 | [Split `api.ts`](06-split-api-routes.md) | Small after 1–3 | 1, 2, 3 (hard) | ⬜ blocked on 3 |

Tasks 1, 4 and 5 were run in parallel by three agents in separate git worktrees
and merged in that order. All conflicts were unions — import lists, Eleventy
globals, doc sections — with no semantic collisions.

## Remaining order

```
Task 3 (repository) ── 1 and 2 both satisfied; ready to start
        │
Task 6 (split api.ts) ── hard dep on 3
```

What is left is a chain, not a fan-out: 3 → 6 must go in order, so there is no
parallelism to exploit the way there was for 1/4/5. Task 3 is the one worth
reserving for whoever knows the data model best — it is the only remaining task
where a silent behaviour change is likely.

---

## Ground rules for all of these

- **Local dev needs an FHS container on Guix.** Anything that spawns `workerd`
  (`wrangler dev`, `wrangler d1 execute --local`, `vitest`) — see the Testing
  section of `AGENTS.md`.
- **Verify against `wrangler dev`, not just `tsc`.** `tsc --noEmit` and
  `npm run build` passing proves very little here; the risky changes are all
  runtime behaviour.
- **Asset routing precedence is the standing footgun.** Cloudflare serves a
  matching static asset *before* invoking the Worker. Adding
  `templates/pages/foo.njk` silently shadows a `GET /foo` Worker route. Task 1
  turned this into a failing test (`test/assets.test.ts`), so it is caught by
  `npx vitest run` — but only against a built `public/`. Use `npm run check`,
  which builds first.
- **Run the whole suite, both projects.** `npx vitest run` with no arguments.
  The guard tests live in the node project; narrowing to the workers project
  silently drops them.

### Running several of these in parallel

If tasks are handed to concurrent agents, give each one its own `git worktree`
and its own `wrangler dev` port. Hardlink `node_modules` (`cp -al`) to avoid
copying 400+ MB per tree, then delete `.cache` and `.vite` from the copy so tool
writes do not travel back through the hardlinks. Note that **git does not work
inside the FHS container when the cwd is a worktree** — a worktree's `.git` is a
file pointing outside the mapped directory, so run git on the host and only
build/test inside the container.
