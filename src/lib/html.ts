/**
 * Worker-rendered HTML is built by string concatenation, so every interpolated
 * value that could originate from a user MUST pass through escapeHtml().
 */
export function escapeHtml(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** Timestamps are Unix epoch seconds; conference dates are stored as UTC midnight. */
export function formatDate(timestamp: number): string {
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

/** Drops the redundant year from the start date when both ends share one. */
export function formatDateRange(start: number, stop: number): string {
    if (!Number.isFinite(start) || !Number.isFinite(stop)) return '';

    const startDate = new Date(start * 1000);
    const stopDate = new Date(stop * 1000);

    if (startDate.getUTCFullYear() === stopDate.getUTCFullYear()) {
        const shortStart = startDate.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
        });
        return `${shortStart} – ${formatDate(stop)}`;
    }

    return `${formatDate(start)} – ${formatDate(stop)}`;
}

export interface PageOptions {
    /**
     * Rendered into <meta name="description"> and the OpenGraph tags, so this
     * is what search results and chat/link previews show. Only pages with real
     * server-rendered content should set it.
     */
    description?: string;
    /** Absolute URL of the page, for og:url. */
    canonicalUrl?: string;
}

/** Collapses whitespace and truncates on a word boundary for meta tags. */
export function summarize(text: string, maxLength = 160): string {
    const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (collapsed.length <= maxLength) return collapsed;
    const clipped = collapsed.slice(0, maxLength - 1);
    const lastSpace = clipped.lastIndexOf(' ');
    return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/**
 * Server-side counterpart to templates/layouts/base.njk.
 *
 * Keep the two navs in sync. Both load user state and subject links as HTMX
 * fragments so this function stays synchronous and DB-free. `options` is the
 * equivalent of base.njk's `{% block head %}`.
 */
export function renderFullPage(title: string, content: string, options: PageOptions = {}): string {
    const currentYear = new Date().getFullYear();
    const fullTitle = `${title} – ResearchRoomies`;

    // Crawlers and chat link-unfurlers do not run HTMX, so anything they should
    // see has to be in the served HTML, not swapped in on load.
    const metaHtml = [
        options.description
            ? `<meta name="description" content="${escapeHtml(options.description)}" />`
            : '',
        `<meta property="og:title" content="${escapeHtml(fullTitle)}" />`,
        options.description
            ? `<meta property="og:description" content="${escapeHtml(options.description)}" />`
            : '',
        `<meta property="og:type" content="website" />`,
        options.canonicalUrl
            ? `<meta property="og:url" content="${escapeHtml(options.canonicalUrl)}" />`
            : '',
        `<meta name="twitter:card" content="summary" />`,
    ]
        .filter(Boolean)
        .join('\n  ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(fullTitle)}</title>
  ${metaHtml}
  ${options.canonicalUrl ? `<link rel="canonical" href="${escapeHtml(options.canonicalUrl)}" />` : ''}
  <link rel="stylesheet" href="/style/style.css" />
  <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.7/dist/htmx.min.js" integrity="sha384-ZBXiYtYQ6hJ2Y0ZNoYuI+Nq5MqWBr+chMrS/RkXpNzQCApHEhOt2aY8EJgqwHLkJ" crossorigin="anonymous"></script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
  <header>
    <div class="logo-nav">
      <h1><a href="/">ResearchRoomies</a></h1>
      <nav>
        <a href="/search" class="nav-link">Search</a>
        <a href="/create" class="nav-link">Create Post</a>
        <span id="nav-user-state" hx-get="/api/components/nav-user" hx-trigger="load" hx-swap="outerHTML"></span>
        <span id="nav-subjects" hx-get="/api/components/nav-subjects" hx-trigger="load" hx-swap="outerHTML"></span>
      </nav>
    </div>
  </header>

  <main>
    ${content}
  </main>

  <footer>
    <div class="fat-footer">
      <p>&copy; ${currentYear} ResearchRoomies. All rights reserved.</p>
      <a href="/about">About</a> | <a href="/terms">Terms</a> | <a href="/privacy">Privacy</a>
    </div>
  </footer>
</body>
</html>`;
}
