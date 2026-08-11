# Task 5 — Configuration module

> ## ✅ Landed 2026-08-10
>
> `src/lib/config.ts` is on `main`. **No manual step is needed before deploying:**
> `TURNSTILE_SITE_KEY` ships in the committed `wrangler.toml`, no secret was
> rotated, and the four optional overrides are unset and default to today's
> values.
>
> **The three open decisions, as resolved:**
> 1. **`[vars]` + an Eleventy global**, not a shared partial. A partial still
>    holds the key in a `.njk` file, leaving two definitions in two languages.
>    `wrangler.toml` is now the only place it exists; `eleventy.config.js` parses
>    it back out at build time and **throws if absent**, and `npm run deploy`
>    builds first, so a dead widget cannot ship. Verified by commenting the var
>    out and watching the build fail.
> 2. **Documentation fix for `MAILGUN_SENDING_KEY`**, not a rename — renaming
>    means hand-rotating a deployed secret for zero functional gain.
>    `config.mailgun.from` carries the correct meaning.
> 3. **Yes to generating the TTL copy.** Both email bodies and the expired-link
>    page get "15 minutes" from `formatTtlMinutes(MAGIC_LINK_TTL_SECONDS)`.
>
> **One intentional micro-deviation:** `MAILGUN_SENDING_KEY` is now trimmed. A
> whitespace-padded value was broken before (`" login "` → `" login @domain"`),
> so this can only fix a config, never change a working one.
>
> **TTLs were deliberately left as constants**, not env-overridable — fewer `Env`
> fields, no parse-failure mode, and "exactly one definition" is what the
> criterion asked for.

**Size:** Small
**Depends on:** nothing
**Risk:** Low, but it touches auth and email — verify a real login end-to-end
before deploying

---

## Problem

Deployment configuration is scattered as literals across six files.

Line numbers below are as of the review; they have since shifted.

| Value | Locations |
|---|---|
| Turnstile sitekey `0x4AAAAAAByAHmDummOs9UGm` | `routes/api.ts`, `routes/flags.ts`, `templates/pages/create.njk`, `templates/pages/login.njk` — 4 sites, 2 languages |
| `SESSION_TTL` (30 days) | `lib/auth.ts:21` **and** `routes/auth.ts:7` — independently defined |
| `APP_ORIGIN` | `routes/auth.ts:5`, hardcoded to production |
| `MAILGUN_DOMAIN`, `MAILGUN_API_BASE`, `ADMIN_EMAIL` | `lib/mailgun.ts` |
| Post URL base `https://researchroomies.com/post/` | `lib/mailgun.ts` |
| Cookie name | `lib/session.ts` — correctly, one place |

### The `SESSION_TTL` duplication is the sharpest

One definition sets the cookie's `Max-Age`; the other sets the session token's
`exp` claim. They agree today by coincidence, not by construction. If they
diverge, users get either a cookie carrying an already-dead token — a silent,
confusing logout — or a still-valid token discarded early.

### The hardcoded origin makes a staging environment impossible

`APP_ORIGIN` in `routes/auth.ts` is a literal production string, so a magic link
generated under `wrangler dev` emails a link pointing at researchroomies.com.

**The login flow cannot currently be tested anywhere except production.** That is
the real payoff of this task; deduplication is secondary.

---

## Scope

```ts
// src/lib/config.ts

export interface AppConfig {
  origin: string;               // env.APP_ORIGIN ?? derived from the request URL
  sessionTtlSeconds: number;
  magicLinkTtlSeconds: number;
  turnstileSiteKey: string;
  mailgun: { domain: string; apiBase: string; from: string };
  adminEmail: string;
}

export function getConfig(env: Env, request?: Request): AppConfig;
```

### Design notes

- **`origin` should default to `new URL(request.url).origin`**, not to a literal.
  Dev and preview then work with no configuration at all, and the current
  hardcoded production value becomes an override rather than a requirement.

  > ⚠️ **This premise is wrong about `wrangler dev`, and the task proved it.**
  > Because `wrangler.toml` declares `[[routes]] pattern = "researchroomies.com"`,
  > `wrangler dev` synthesizes the request URL from that route
  > (`--local-upstream` defaults to "dev.host or route"). Plain `npm run dev`
  > therefore still yields `http://researchroomies.com/api/auth/callback?...`
  > even though the code is now correct. Pinning it takes a flag:
  >
  > ```bash
  > npx wrangler dev --port 8787 --local-upstream localhost:8787 --upstream-protocol http
  > ```
  >
  > No committed fix was made, because every committed form (`[dev] host`, or
  > baking the flag into the `dev` script) has to hardcode a port — and
  > `--local-upstream localhost` without one drops the port entirely, yielding an
  > unclickable `http://localhost`. Documented in `AGENTS.md` and the `CLAUDE.md`
  > backlog instead.

- **Add `TURNSTILE_SITE_KEY` (the public key) to `[vars]` in `wrangler.toml`**
  and expose it to templates via an Eleventy global, so the two `.njk` sitekeys
  read from the same source as the two TypeScript ones. Alternatively, render the
  `<div class="cf-turnstile">` from a shared partial. Either is fine; pick one
  and note it.

  Do **not** move `TURNSTILE_SECRET_KEY` into `[vars]` — it stays a secret.

- **Update `worker-configuration.d.ts`** for any new `Env` fields, matching the
  existing comment style there.

- **While here: `MAILGUN_SENDING_KEY` is misnamed.** `lib/mailgun.ts` already
  documents that it "is not a key — it is the From address," given either as a
  bare local part (`login`) or in full (`login@example.com`). Renaming it
  requires rotating a deployed secret, so a documentation-only fix is acceptable.
  State in the PR which was chosen.

- **`magicLinkTtlSeconds`** currently lives as `MAGICLINK_TTL` in `lib/auth.ts`
  and is also stated in prose in two Mailgun email bodies ("This link is valid
  for 15 minutes"). Consider passing the value into the email templates so the
  copy cannot drift from the actual TTL.

---

## Acceptance criteria

- [x] Exactly one definition each of the session TTL and the Turnstile sitekey. —
      `grep 0x4AAA src/ templates/` returns nothing; the only site is
      `wrangler.toml`. `SESSION_TTL_SECONDS` is one constant.
- [x] No `researchroomies.com` literal anywhere in `src/` outside
      `src/lib/config.ts`. — the `iss: 'researchroomies'` token claim in
      `lib/auth.ts` is deliberately untouched; changing it invalidates every live
      session.
- [x] A magic link generated under `wrangler dev` points at localhost — **with
      the `--local-upstream` flag above.** Captured verbatim:
      `http://localhost:8805/api/auth/callback?token=...`. The doc's claim that
      this needs no configuration is wrong; see the note in Design notes.
- [x] **Existing production behaviour is unchanged when the new vars are unset.**
      Each default checked against the literal it replaced, and pinned by 23 unit
      assertions in `test/config.test.ts`.
- [x] `worker-configuration.d.ts` reflects any new `Env` fields. —
      `TURNSTILE_SITE_KEY` (required) plus optional `APP_ORIGIN`,
      `MAILGUN_DOMAIN`, `MAILGUN_API_BASE`, `ADMIN_EMAIL`.

---

## Verification

The auth path is the risk. With `wrangler dev` running in the FHS container:

1. Request a magic link for a test address. Confirm the emailed link points at
   `localhost:8788`, not researchroomies.com.
2. Follow it. Confirm the session cookie is set and `Max-Age` matches the token's
   `exp` claim — decode the token payload (it is base64url JSON before the `.`)
   and check `exp - iat` equals the cookie's `Max-Age`. **This is the specific
   bug the duplication could produce; check it explicitly.**
3. Confirm the Turnstile widget still renders and validates on `/login`,
   `/create`, and `/post/:id/report`. A wrong sitekey fails visibly, but only on
   the page you look at — check all three.
4. Confirm a report email still reaches `admin@researchroomies.com` with a
   correct post link.

### ⚠️ Do not send real mail while verifying

`.dev.vars` holds a live Mailgun key, and steps 1 and 4 both send to third
parties. Stub the API instead:

```bash
npx wrangler dev --port 8787 \
  --local-upstream localhost:8787 --upstream-protocol http \
  --var MAILGUN_API_BASE:http://127.0.0.1:8899/v3 \
  --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA
```

Run any HTTP server on 8899 to capture the multipart body. The second `--var` is
Cloudflare's always-passing Turnstile test secret, so forms submit without a
browser. CLI `--var` does override `.dev.vars` — confirmed.

### Results

**Step 2 — the bug this task exists to prevent.** Real login followed, payload
decoded:

```
payload : {"v":1,"sub":"3",...,"iat":1786401066,"exp":1788993066,"aud":"session"}
exp - iat     : 2592000
cookie Max-Age: 2592000
SESSION_TTL   : 2592000        → MATCH
```

Cookie attributes byte-identical to before (`HttpOnly; Secure; SameSite=Lax;
Path=/`). Logout still emits `Max-Age=0` + `HX-Redirect: /`.

**Step 3 — four sites, not three.** The doc lists `/login`, `/create` and
`/post/:id/report`; `/post/:id` also renders a widget for its inquiry form. All
four serve `data-sitekey="0x4AAAAAAByAHmDummOs9UGm"`, two from Eleventy and two
from the Worker.

**Step 4 —** captured, not delivered: `to: admin@researchroomies.com`,
`Link: https://researchroomies.com/post/3`,
`POST /v3/researchroomies.com/messages`,
`from: Research Roomies <login@researchroomies.com>` — all identical to
pre-change.
