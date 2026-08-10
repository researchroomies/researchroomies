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

Taken from the working tree on 2026-08-10, after the Round 2 hardening pass
described in `CLAUDE.md`. The "before" column is the same measurement taken
before that pass, included because two numbers moved the wrong way — the
hardening fixed real defects but did so by adding more of the same shapes.

| Metric | Before Round 2 | Now |
|---|---|---|
| `src/routes/api.ts` | 1,094 lines | **1,199** |
| `renderFullPage()` call sites | 24 | **29** |
| `try {` blocks in `src/` | 22 | **24** |
| `"text/html"` vs `"text/html; charset=utf-8"` | 28 / 7 | **29 / 12** |
| `getSessionUser()` call sites | 14 | **15** |
| `DB.prepare()` call sites | 30 | 30 |
| Turnstile sitekey literals | 4 | 4 |
| `SESSION_TTL` definitions | 2 | 2 |
| Handler tests | 0 | 0 |

`src/` is ~2,400 lines of TypeScript. `api.ts` alone is 43% of it.

---

## Duplication inventory

| Repeated thing | Sites | Consequence |
|---|---|---|
| `env.DB.prepare(...)` with inline SQL | 30 | Row shapes redeclared 6+ ways. No single definition of "a Post". |
| `getSessionUser()` + failure branch | 15 | Three inconsistent failure modes for the same condition. |
| Hand-built `new Response(html, {headers})` | 41 | Charset written two ways; cache policy chosen ad hoc. |
| `try { ... } catch` per handler | 24 | Error response shape re-decided each time. |
| Turnstile sitekey `0x4AAA…` | 4 (2 TS, 2 njk) | Rotating the widget means 4 edits across two languages. |
| `SESSION_TTL = 30 days` | 2 files | Cookie `Max-Age` and token `exp` independently defined. |
| `escapeHtml` | 2 (`html.ts`, `mailgun.ts`) | `escapeHtmlForEmail` is a byte-identical copy. |

Near-identical `SELECT posts JOIN conferences` appears in `handleComponentPost`,
`handleEditPostForm` and `handleReportForm` with slightly different column lists.

---

## Invariants currently maintained by documentation instead of code

These are the fragile ones. Each has either broken already or can break
silently, and each is guarded today only by a paragraph of prose.

1. **`renderFullPage()` ⟷ `base.njk`.** `CLAUDE.md` says "change both
   together." That instruction *is* the seam; there isn't one in code. It has
   drifted before and is drifting again now. → [Task 4](04-single-page-shell.md)

2. **`run_worker_first` ⟷ the route table.** `wrangler.toml` restates by hand
   which paths the Worker owns, and is currently missing three of them.
   → [Task 1](01-response-module-and-route-guards.md)

3. **Turnstile always goes through `verifyTurnstile()`.** `src/routes/auth.ts`
   hand-rolls its own siteverify call and ignores the module.
   → [Task 2](02-auth-and-ownership-guards.md)

4. **Every interpolated value passes `escapeHtml()`.** Currently held
   everywhere — Round 2 closed the last gap in `sendInquiryEmail`. Nothing
   enforces it beyond review, but string-concatenated HTML makes this hard to
   fix structurally; noted rather than assigned.

---

## Testability

There are 190 lines of tests, all against pure functions: `Router`, token
crypto, `isEmailAllowed`, `parseRouteId`. **There are no handler tests.**

That is not a discipline gap — it is a consequence of the shape. A handler takes
`(Request, Env, ExecutionContext)` and reaches straight into `env.DB` with raw
SQL, so exercising one requires a real database and a real HTTP round trip. The
72 end-to-end assertions from the last review round were run by hand against
`wrangler dev` and no longer exist.

`@cloudflare/vitest-pool-workers` is configured and provides a real D1 in
process, and nothing uses it. [Task 3](03-repository-module.md) is what makes
handler tests possible without it.

---

## Tasks

| # | Task | Size | Depends on |
|---|---|---|---|
| 1 | [Response module + route-ownership guard tests](01-response-module-and-route-guards.md) | Medium | — |
| 2 | [Auth and ownership guards](02-auth-and-ownership-guards.md) | Medium | 1 (soft) |
| 3 | [Repository module](03-repository-module.md) | Large | 1, 2 (soft) |
| 4 | [Collapse the two page shells](04-single-page-shell.md) | Small–medium | — |
| 5 | [Configuration module](05-config-module.md) | Small | — |
| 6 | [Split `api.ts`](06-split-api-routes.md) | Small after 1–3 | 1, 2, 3 (hard) |

## Suggested order

```
Task 1 (responses + guard tests) ──┐
Task 5 (config) ───────────────────┤── independent, parallelizable
Task 4 (page shell) ───────────────┘
        │
Task 2 (auth guards) ── soft dep on 1
        │
Task 3 (repository) ── benefits from 1 + 2
        │
Task 6 (split api.ts) ── hard dep on 1 + 2 + 3
```

Tasks 1, 4 and 5 have no dependencies on each other and can go to three
different people. Task 3 is the one worth reserving for whoever knows the data
model best — it is the only task where a silent behaviour change is likely.

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
  turns this into a failing test; until it lands, keep checking by hand.
