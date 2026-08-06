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

/**
 * Server-side counterpart to templates/layouts/base.njk.
 *
 * Keep the two navs in sync. Both load user state and subject links as HTMX
 * fragments so this function stays synchronous and DB-free.
 */
export function renderFullPage(title: string, content: string): string {
    const currentYear = new Date().getFullYear();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} – ResearchRoomies</title>
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
