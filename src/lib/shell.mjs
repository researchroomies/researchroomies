/**
 * The single definition of the ResearchRoomies page chrome — doctype, <head>,
 * nav, and footer. There is no second copy.
 *
 * Plain ESM (no TypeScript syntax) so every consumer can load this file
 * unchanged:
 *
 *   - the Worker bundle, through `renderFullPage()` in `src/lib/html.ts`
 *   - `scripts/gen-layout.mjs`, which projects it through Nunjucks markers to
 *     generate `templates/layouts/base.njk` for Eleventy at build time
 *   - `test/shell.test.ts`, which re-renders the committed layout and diffs it
 *     against the Worker-rendered page
 *
 * `templates/layouts/base.njk` is generated, not written. Edit the chrome here;
 * `npm run build` regenerates the layout, and `test/shell.test.ts` fails if the
 * committed layout has drifted from what this module produces.
 *
 * Escaping contract: `title`, `description`, `canonicalUrl` and `year` are
 * plain text and are escaped here. `head` and `content` are raw HTML — the
 * caller is responsible for having escaped anything user-supplied inside them,
 * with `escapeHtml()` on the Worker side and Nunjucks autoescape on the
 * Eleventy side.
 */

/** @type {string} */
const SITE_NAME = 'ResearchRoomies';

/** The one separator between a page title and the site name: an en dash. */
const TITLE_SEPARATOR = ' – ';

const HTMX_SCRIPT =
    '<script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.7/dist/htmx.min.js" integrity="sha384-ZBXiYtYQ6hJ2Y0ZNoYuI+Nq5MqWBr+chMrS/RkXpNzQCApHEhOt2aY8EJgqwHLkJ" crossorigin="anonymous"></script>';

const TURNSTILE_SCRIPT =
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';

/**
 * Worker-rendered HTML is built by string concatenation, so every interpolated
 * value that could originate from a user MUST pass through this.
 *
 * Lives here rather than in `html.ts` because the shell needs it and this
 * module cannot import TypeScript. `html.ts` re-exports it, so every existing
 * `import { escapeHtml } from '../lib/html'` keeps working.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * @typedef {object} ShellParts
 * @property {string} title Bare page title; the site name is appended here.
 * @property {string} [description] Plain text for <meta name="description">
 *   and the OpenGraph tags. Omit only for pages with no indexable content —
 *   the description and og:description tags are then left out entirely.
 * @property {string} [canonicalUrl] Absolute URL, for og:url and
 *   <link rel="canonical">. Omitted tags when absent.
 * @property {string} [head] Raw HTML appended to <head>; the Eleventy
 *   `{% block head %}` slot. The Worker does not use it.
 * @property {string} [content] Raw HTML for <main>.
 * @property {string|number} [year] Year shown in the footer copyright.
 */

/**
 * Renders a complete HTML document around `content`.
 *
 * @param {ShellParts} parts
 * @returns {string}
 */
export function renderShell({
    title,
    description = '',
    canonicalUrl = '',
    head = '',
    content = '',
    year = '',
}) {
    const fullTitle = `${escapeHtml(title)}${TITLE_SEPARATOR}${SITE_NAME}`;
    const desc = escapeHtml(description);
    const canonical = escapeHtml(canonicalUrl);

    // Crawlers and chat link-unfurlers do not run HTMX, so anything they should
    // see has to be in the served HTML, not swapped in on load.
    const headHtml = [
        '<meta charset="UTF-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        `<title>${fullTitle}</title>`,
        desc ? `<meta name="description" content="${desc}" />` : '',
        `<meta property="og:title" content="${fullTitle}" />`,
        desc ? `<meta property="og:description" content="${desc}" />` : '',
        '<meta property="og:type" content="website" />',
        canonical ? `<meta property="og:url" content="${canonical}" />` : '',
        '<meta name="twitter:card" content="summary" />',
        canonical ? `<link rel="canonical" href="${canonical}" />` : '',
        '<link rel="stylesheet" href="/style/style.css" />',
        HTMX_SCRIPT,
        TURNSTILE_SCRIPT,
        head,
    ]
        .filter(Boolean)
        .join('\n  ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${headHtml}
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
      <p>© ${escapeHtml(year)} ResearchRoomies. All rights reserved.</p>
      <a href="/about">About</a> | <a href="/terms">Terms</a> | <a href="/privacy">Privacy</a>
    </div>
  </footer>
</body>
</html>`;
}

/**
 * The values `renderLayoutTemplate()` feeds to `renderShell()` to produce the
 * Eleventy layout. Each is a Nunjucks expression rather than a real value, so
 * the generated file is a template rather than a rendered page.
 *
 * Deliberately no `{% block %}` for the title: a Nunjucks block may only be
 * declared once per template, and the title appears twice (<title> and
 * og:title). Pages supply `title` and `description` as front matter instead;
 * `siteOrigin` and `year` are Eleventy global data (see eleventy.config.js).
 *
 * Exported so `test/shell.test.ts` substitutes the exact same strings the
 * generator emits, rather than a hand-copied guess at them.
 *
 * @type {Readonly<Record<'title'|'description'|'canonicalUrl'|'head'|'content'|'year', string>>}
 */
export const LAYOUT_MARKERS = Object.freeze({
    title: '{{ title }}',
    description: '{{ description }}',
    canonicalUrl: '{{ siteOrigin }}{{ page.url }}',
    // The leading `{%-` strips the newline and indent that renderShell() puts
    // in front of the slot, so a page with an empty {% block head %} produces
    // exactly the <head> renderShell() produces when `head` is omitted — which
    // is every Worker page. Without it, static pages carry a stray blank line
    // that no Worker page has, and the two <head>s are no longer byte-equal.
    head: '{%- block head %}{% endblock %}',
    content: '{% block content %}{% endblock %}',
    year: '{{ year }}',
});

/**
 * A Nunjucks comment, so it costs nothing in the built HTML. Kept on the same
 * line as the doctype so the rendered page still starts at byte 0 with
 * `<!DOCTYPE html>`.
 */
export const GENERATED_LAYOUT_BANNER =
    '{# GENERATED FILE — do not edit. Generated from renderShell() in src/lib/shell.mjs by scripts/gen-layout.mjs, which runs as part of `npm run build`. #}';

/**
 * The full text of `templates/layouts/base.njk`.
 *
 * Deliberately has no trailing newline: Eleventy copies the layout's bytes
 * through verbatim, so one here would make every built page end a byte later
 * than the Worker's, and the two documents would no longer be byte-identical.
 *
 * @returns {string}
 */
export function renderLayoutTemplate() {
    return `${GENERATED_LAYOUT_BANNER}${renderShell(LAYOUT_MARKERS)}`;
}
