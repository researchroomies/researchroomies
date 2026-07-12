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
1. **Worker (`src/index.ts`)**: Entry point for all requests.
2. **Router**: Custom router (`src/lib/router.ts`) handles API paths (`/api/*`) and dynamic pages (`/conference/:slug`, `/post/:id`).
3. **Static Assets**: Requests not matched by the router are served from the `public/` directory (built by Eleventy) via the Cloudflare `ASSETS` binding.

### Rendering modes
- **Static pages** (e.g. `/`, `/login`, `/create`, `/about`): Built by Eleventy at deploy time, served as static files.
- **Worker-rendered pages** (e.g. `/conference/:slug`): Rendered server-side by the Worker with database access.
- **HTMX fragments** (`/api/components/*`): Raw HTML snippets returned by the Worker and swapped into the page by HTMX.

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- npm
- A Cloudflare account authenticated with Wrangler (`npx wrangler login`)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/researchroomies.git
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
   The last value is Cloudflare's public Turnstile test secret that always passes.

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

**Run tests:**
```bash
npm test
```

**Regenerate TypeScript types from `wrangler.toml`:**
```bash
npm run cf-typegen
```

## 🚢 Deployment

```bash
npm run build    # Build Eleventy static pages into public/
npm run deploy   # Deploy Worker + static assets to Cloudflare
```

**Set production secrets (one-time per secret):**
```bash
npx wrangler secret put AUTH_HMAC_SECRET
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_SENDING_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

## 📂 Project Structure

```text
├── db/
│   └── schema.sql          # D1 database schema
├── public/                 # Eleventy build output (do not edit directly)
│   └── style/style.css
├── src/
│   ├── lib/
│   │   ├── auth.ts         # Token generation/verification (HMAC-SHA256)
│   │   ├── mailgun.ts      # Magic link + inquiry email sending
│   │   └── router.ts       # Custom path-param router
│   ├── routes/
│   │   ├── api.ts          # Page renders and API handlers
│   │   └── auth.ts         # Magic link login, session, logout
│   └── index.ts            # Worker entry point and route registration
├── templates/
│   ├── layouts/
│   │   └── base.njk        # Base HTML layout (header, footer, HTMX)
│   ├── pages/              # Eleventy source pages (.njk)
│   └── style/style.css     # Global stylesheet source
├── test/
│   └── auth_verification.test.ts
├── eleventy.config.js      # Eleventy configuration
├── wrangler.toml           # Cloudflare deployment config
├── AGENTS.md               # Technical reference for AI agents and contributors
└── CLAUDE.md               # Pending implementation plan and backlog
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
| `message` | Inquiry messages sent through the platform |
| `flags` | Abuse reports on posts |
| `tags` / `conference_tags` | Subject tag system (schema ready, UI pending) |

All timestamps are stored as Unix epoch seconds (INTEGER).

## 🤝 Contributing

See [`AGENTS.md`](./AGENTS.md) for a full technical reference covering rendering architecture, auth patterns, database conventions, route registration, and common pitfalls.

See [`CLAUDE.md`](./CLAUDE.md) for the current backlog of planned features and fixes.
