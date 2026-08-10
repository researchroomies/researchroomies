import { renderShell } from './shell.mjs';

/**
 * Worker-rendered HTML is built by string concatenation, so every interpolated
 * value that could originate from a user MUST pass through escapeHtml().
 *
 * Defined in `./shell.mjs` — which is plain ESM so Eleventy's build script can
 * load it too — and re-exported here so `import { escapeHtml } from '../lib/html'`
 * keeps working everywhere.
 */
export { escapeHtml } from './shell.mjs';

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
 * Renders a full Worker page through the shared page shell.
 *
 * The chrome itself lives in `src/lib/shell.mjs`, which also generates
 * `templates/layouts/base.njk` — Worker-rendered and Eleventy-built pages come
 * out of the same function, so there is nothing to keep in sync by hand.
 * `test/shell.test.ts` diffs the two and fails if they diverge.
 *
 * `title` is bare; the shell appends the site name. `options` is the Worker's
 * equivalent of the layout's per-page `description` / canonical front matter.
 * Both sides load nav user state and subject links as HTMX fragments, so this
 * stays synchronous and DB-free.
 */
export function renderFullPage(title: string, content: string, options: PageOptions = {}): string {
    return renderShell({
        title,
        description: options.description ?? '',
        canonicalUrl: options.canonicalUrl ?? '',
        content,
        year: String(new Date().getFullYear()),
    });
}
