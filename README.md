# Research Roomies 🎓

A platform for connecting academic conference attendees to find roommates and carpools.

## 🏗 Architecture

This project is built on the [Cloudflare Connect](https://developers.cloudflare.com/workers/) implementation model, leveraging the following technologies:

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (Serverless execution)
- **Language**: TypeScript
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite at the edge)
- **Static Site Generation**: [Eleventy (11ty)](https://www.11ty.dev/)
- **Testing**: [Vitest](https://vitest.dev/)

### Request Flow
1. **Worker (`src/index.ts`)**: The entry point for all requests.
2. **Router**: Custom router (`src/lib/router.ts`) handles API paths (`/api/*`) and dynamic pages (`/conference/:slug`).
3. **Static Assets**: Requests not matched by the router are served from the `public/` directory (built by 11ty) via the Cloudflare `ASSETS` binding.

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- npm

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

3. **Setup Local Database**
   Initialize the local D1 database with the schema:
   ```bash
   npx wrangler d1 execute research-roomies --local --file=./db/schema.sql
   ```

### 🛠 Development

Start the development server:
```bash
npm run dev
```
This command runs `wrangler dev`, which emulates the Cloudflare Workers environment locally.

**Build Static Assets:**
To rebuild the frontend templates (Eleventy):
```bash
npm run build
```

**Run Tests:**
```bash
npm test
```

## 📂 Project Structure

```text
├── db/                 # Database schema and migrations
├── public/             # API build output (gitignored, served by Worker)
├── src/                # Cloudflare Worker source code
│   ├── lib/            # Shared utilities and router
│   ├── routes/         # Request handlers
│   └── index.ts        # Worker entry point
├── templates/          # Eleventy templates (pages, layouts)
├── test/               # Vitest test files
├── eleventy.config.js  # 11ty configuration
└── wrangler.toml       # Cloudflare deployment config
```

## 🤝 Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add some feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
