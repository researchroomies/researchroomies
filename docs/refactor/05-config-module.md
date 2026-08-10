# Task 5 — Configuration module

**Size:** Small
**Depends on:** nothing
**Risk:** Low, but it touches auth and email — verify a real login end-to-end
before deploying

---

## Problem

Deployment configuration is scattered as literals across six files.

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

- [ ] Exactly one definition each of the session TTL and the Turnstile sitekey.
- [ ] No `researchroomies.com` literal anywhere in `src/` outside
      `src/lib/config.ts`.
- [ ] A magic link generated under `wrangler dev` points at localhost.
- [ ] **Existing production behaviour is unchanged when the new vars are unset.**
      Every default must reproduce today's value exactly — this task should be
      invisible in production.
- [ ] `worker-configuration.d.ts` reflects any new `Env` fields.

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
