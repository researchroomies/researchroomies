# Research Roomies 🎓

A platform for connecting academic conference attendees to find roommates and carpools.

Live site: **[researchroomies.com](https://researchroomies.com)**

## 🏗 Architecture

This project is built on [Cloudflare](https://developers.cloudflare.com/workers/), leveraging the following technologies:

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (Serverless execution)
- **Language**: TypeScript
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite at the edge)
- **Static Site Generation**: [Eleventy (11ty)](https://www.11ty.dev/) with Nunjucks templates
- **Frontend interactivity**: [HTMX 2](https://htmx.org/) + vanilla JavaScript
- **Authentication**: Custom magic-link email + HMAC-SHA256 signed session tokens
- **CAPTCHA**: [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
- **Email**: [Mailgun](https://www.mailgun.com/) REST API

### Request Flow
1. **Worker (`src/index.ts`)**: Entry point for all requests. ~39 lines — dispatch, the trailing-slash redirect, and the asset fallthrough, nothing else.
2. **Router**: the route table lives in `src/routes.ts` as `ROUTES`; the router itself (`src/lib/router.ts`) handles API paths (`/api/*`), Worker-rendered pages (`/conference/:slug`, `/subject/:slug`, `/post/:id`, `/my-posts`, `/search`), and post-ownership/moderation actions (`/post/:id/edit`, `/post/:id/delete`, `/post/:id/report`). Dispatch asks `router.match()` directly, so adding an entry to `ROUTES` is all it takes to make a route reachable.
3. **Trailing slashes**: Routes are registered without one. `/foo/` gets a `308` redirect to `/foo`, but *only* when the trimmed path is a registered Worker route — Eleventy pages are genuinely directory-style, so `/about/` must keep falling through.
4. **Static Assets**: Requests not matched by the router are served from the `public/` directory (built by Eleventy) via the Cloudflare `ASSETS` binding.

### Rendering modes
- **Static pages** (e.g. `/`, `/login`, `/create`, `/about`): Built by Eleventy at deploy time, served as static files.
- **Worker-rendered pages** (e.g. `/conference/:slug`, `/search`, `/my-posts`): Rendered server-side by the Worker with database access.
- **HTMX fragments** (`/api/components/*`): Raw HTML snippets returned by the Worker and swapped into the page by HTMX.

### ⚠️ Gotchas

**Static assets are matched *before* the Worker runs.** Adding `templates/pages/foo.njk` builds to `public/foo/index.html` and will silently shadow a `GET /foo` Worker route — the handler simply never runs. This is exactly how `/search` broke. Either don't create the template, or add the path to `run_worker_first` in `wrangler.toml`. `test/assets.test.ts` now fails on both mistakes, but only against a built `public/` — use `npm run check`. Note that deleting a template does *not* remove its already-built output, and the stale directory shadows the route just as well.

**All HTML responses go through `src/lib/response.ts`.** `pageResponse()`, `fragmentResponse()`, and the shared `notFoundPage()` / `forbiddenPage()` / `errorPage()`. Cache policy is picked from a closed union and defaults to `private`, so a session-varying fragment is never cached publicly by accident.

**`templates/layouts/base.njk` is generated — do not edit it.** The page chrome lives once, in `renderShell()` (`src/lib/shell.mjs`); `scripts/gen-layout.mjs` writes the Eleventy layout from it during `npm run build`, and `renderFullPage()` calls the same function for Worker-rendered pages. `test/shell.test.ts` diffs the two byte for byte. This used to be two hand-maintained copies, and they drifted: Worker-rendered pages lost their nav login state.

**Worker HTML is string-concatenated**, so every interpolated database or user value must pass through `escapeHtml()` from `src/lib/html.ts`.

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- npm
- A Cloudflare account authenticated with Wrangler (`npx wrangler login`)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/researchroomies/researchroomies.git
   cd researchroomies
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Setup local secrets**
   Create a `.dev.vars` file in the project root (never commit this):
   ```
   AUTH_HMAC_SECRET=any-local-secret-string
   MAILGUN_API_KEY=your-mailgun-api-key
   MAILGUN_SENDING_KEY=login
   TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
   ```
   - `TURNSTILE_SECRET_KEY` above is Cloudflare's public Turnstile test secret, which always passes.
   - `MAILGUN_SENDING_KEY` is **not a key** despite the name — it is the *From* address, given either as a bare local part (`login`) or in full (`login@researchroomies.com`). It is optional; when unset, each email falls back to a per-message default local part. The misleading name is kept because it is already set as a deployed secret. See `src/lib/mailgun.ts`.

4. **Setup local D1 database**
   ```bash
   npx wrangler d1 execute research-roomies --local --file=./db/schema.sql
   ```

### 🛠 Development

**Build static pages first (required before `dev`):**
```bash
npm run build
```

**Start the development server:**
```bash
npm run dev
```
This runs `wrangler dev`, which emulates the Cloudflare Workers environment locally with D1 and asset serving.

> Note: `wrangler dev` does not watch Eleventy templates. Re-run `npm run build` after any `.njk` template change, then restart the dev server.

> Note: magic links need one flag locally. The origin is derived from the incoming request (`getConfig()` in `src/lib/config.ts`), but because `wrangler.toml` declares `[[routes]] pattern = "researchroomies.com"`, `wrangler dev` synthesizes that hostname as the request host — so a plain `npm run dev` still emits links pointing at production. Pin it:
> ```bash
> npx wrangler dev --port 8787 --local-upstream localhost:8787 --upstream-protocol http
> ```
> The host must include the port; `--local-upstream localhost` drops it and yields an unclickable `http://localhost`.

> ⚠️ **Do not point local dev at the real Mailgun API** while testing login or reporting — `.dev.vars` holds a live key and real third parties receive whatever you send. Stub it with `--var MAILGUN_API_BASE:http://127.0.0.1:8899/v3` and run any HTTP server on that port to capture the request body. CLI `--var` overrides `.dev.vars`.

**Run tests:**
```bash
npm test          # watch mode
npm run check     # build, then run the full suite, then tsc --noEmit
```

`npm run check` is the one to use after a clean checkout or before deploying. The order is load-bearing: `test/assets.test.ts` inspects the Eleventy output in `public/`, so it must run after a build.

**Regenerate TypeScript types from `wrangler.toml`:**
```bash
npm run cf-typegen
```

## 🚢 Deployment

```bash
npm run deploy   # Runs the Eleventy build, then deploys Worker + assets
```

`deploy` is `npm run build && wrangler deploy`, so it cannot ship stale HTML. The build also fails hard if `TURNSTILE_SITE_KEY` is missing from `wrangler.toml`, which means a broken CAPTCHA cannot reach production either.

**Plain vars in `[vars]` in `wrangler.toml`** (committed; change by editing the file and redeploying):

| Variable | Default | Purpose |
|---|---|---|
| `TURNSTILE_SITE_KEY` | — (required) | Public Turnstile sitekey. The single definition — both the Worker and the Eleventy build read it from here |
| `RESTRICT_EDU_EMAILS` | `"false"` | `"true"` limits accounts to `.edu` addresses. It rejects international academic domains (`.ac.uk`, `.edu.au`) and applies to existing users as well as new signups — see `CLAUDE.md` before enabling |

**Optional overrides**, read by `getConfig()` in `src/lib/config.ts`. None are set today, and every default reproduces the value that used to be hardcoded, so leaving them unset is current production behaviour. Add them only when standing up a second environment.

| Variable | Default |
|---|---|
| `APP_ORIGIN` | the origin of the incoming request |
| `MAILGUN_DOMAIN` | `researchroomies.com` |
| `MAILGUN_API_BASE` | `https://api.mailgun.net/v3` (EU domains need `https://api.eu.mailgun.net/v3`) |
| `ADMIN_EMAIL` | `admin@researchroomies.com` |

**Set production secrets (one-time per secret):**
```bash
npx wrangler secret put AUTH_HMAC_SECRET
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_SENDING_KEY   # a From address, not a key — see above
npx wrangler secret put TURNSTILE_SECRET_KEY
```

## 📂 Project Structure

```text
├── db/
│   ├── schema.sql          # D1 database schema (idempotent; safe to re-run)
│   └── README.md
├── public/                 # Eleventy build output (git-ignored, do not edit directly)
│   └── style/style.css
├── src/
│   ├── lib/
│   │   ├── auth.ts         # Token generation/verification (HMAC-SHA256), .edu gate
│   │   ├── config.ts       # getConfig() – every deployment literal, defined once
│   │   ├── html.ts         # renderFullPage(), date helpers, escapeHtml() re-export
│   │   ├── mailgun.ts      # Magic link, inquiry, and abuse-report email sending
│   │   ├── params.ts       # parseRouteId() – strict numeric route ids
│   │   ├── response.ts     # Every HTML response + the 404/403/500 pages
│   │   ├── router.ts       # Custom path-param router
│   │   ├── session.ts      # Session cookie read/write, getSessionUser()
│   │   ├── shell.mjs       # renderShell() – the one page chrome, generates base.njk
│   │   └── turnstile.ts    # Server-side CAPTCHA verification + widget markup
│   ├── routes/
│   │   ├── api.ts          # Page renders and API handlers
│   │   ├── auth.ts         # Magic link login, session, logout
│   │   ├── flags.ts        # Post reporting
│   │   └── posts.ts        # Author-only post edit/delete
│   ├── routes.ts           # ROUTES table – the single declaration of Worker-owned paths
│   └── index.ts            # Worker entry point: dispatch, trailing slashes, asset fallthrough
├── scripts/
│   └── gen-layout.mjs      # Writes templates/layouts/base.njk from shell.mjs
├── templates/
│   ├── layouts/
│   │   └── base.njk        # GENERATED from src/lib/shell.mjs – do not edit
│   ├── pages/              # Eleventy source pages (.njk)
│   ├── style/style.css     # Global stylesheet source
│   └── README.md
├── test/
│   ├── assets.test.ts      # No built asset shadows a route; run_worker_first covers all
│   ├── auth_verification.test.ts
│   ├── config.test.ts      # getConfig() defaults, origin derivation, cookie/token TTL match
│   ├── params.test.ts      # parseRouteId()
│   ├── routing.test.ts     # Trailing-slash redirects and route dispatch
│   ├── shell.test.ts       # Generated layout vs. renderFullPage(), byte for byte
│   ├── env.d.ts
│   └── tsconfig.json
├── .dev.vars               # Local secrets (git-ignored, create by hand)
├── eleventy.config.js      # Eleventy configuration
├── vitest.config.mts       # Vitest + @cloudflare/vitest-pool-workers config
├── tsconfig.json
├── worker-configuration.d.ts  # Generated by `npm run cf-typegen`
├── wrangler.toml           # Cloudflare deployment config
├── AGENTS.md               # Technical reference for AI agents and contributors
└── CLAUDE.md               # Current implementation state, open decisions, backlog
```

## 🔑 How Authentication Works

1. User enters their email on `/login`
2. Cloudflare Turnstile CAPTCHA is verified server-side
3. A signed magic link is generated and emailed via Mailgun (valid 15 minutes)
4. User clicks the link → server verifies the token → user is created/updated in D1
5. A 30-day signed session cookie (`rr_session`) is set
6. All protected actions (creating posts, sending messages) verify this cookie

No passwords are stored. Sessions are stateless JWT-style tokens — there is no session table in the database.

## 🗄 Database Schema

Key tables:

| Table | Purpose |
|---|---|
| `users` | Registered users (email + timestamps) |
| `conferences` | Academic conferences (name, slug, location, dates) |
| `posts` | Posts seeking travel partners |
| `message` | Inquiry messages sent through the platform (write-only for now — recorded, not yet surfaced in the UI) |
| `flags` | Abuse reports on posts (emailed to the admin; no in-app review UI yet) |
| `tags` / `conference_tags` | Subject tags, applied at the conference level and browsable at `/subject/:slug` |
| `countries` / `states` / `cities` | Structured locations — intentionally dormant; city/state are free text today |

All timestamps are stored as Unix epoch seconds (INTEGER).

## 🤝 Contributing

See [`AGENTS.md`](./AGENTS.md) for a full technical reference covering rendering architecture, auth patterns, database conventions, route registration, and common pitfalls.

See [`CLAUDE.md`](./CLAUDE.md) for the current implementation state, open decisions, and the backlog of planned features and fixes.
