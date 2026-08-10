import { describe, expect, it } from 'vitest';

// Vite hands back the committed file's exact bytes — the same
// templates/layouts/base.njk that Eleventy compiles at build time.
// @ts-ignore -- no ambient declaration for Vite's ?raw imports
import committedLayout from '../templates/layouts/base.njk?raw';

import {
	GENERATED_LAYOUT_BANNER,
	LAYOUT_MARKERS,
	escapeHtml,
	renderLayoutTemplate,
	renderShell,
} from '../src/lib/shell.mjs';
import { renderFullPage } from '../src/lib/html';

const layoutSource: string = committedLayout;

interface PageValues {
	title: string;
	description: string;
	canonicalUrl: string;
	head: string;
	content: string;
	year: string;
}

/**
 * Renders the committed Nunjucks layout the way Eleventy would, by
 * substituting the exact marker strings the generator emitted for it.
 *
 * This is not a general Nunjucks implementation and does not need to be: the
 * generator emits a closed set of markers, `LAYOUT_MARKERS` is that set, and
 * the caller asserts nothing template-shaped survives. If someone hand-edits
 * base.njk and introduces a marker this does not know about, the leftover
 * check below fails rather than silently passing.
 */
function renderStaticPage(values: PageValues): string {
	let out = layoutSource.replace(GENERATED_LAYOUT_BANNER, '');

	// The head marker opens with `{%-`, Nunjucks whitespace control, which eats
	// the newline and indent in front of it. That is what lets a page with an
	// empty {% block head %} come out byte-identical to a Worker page, which
	// has no head slot at all.
	out = out.replaceAll(`\n  ${LAYOUT_MARKERS.head}`, values.head);
	out = out.replaceAll(LAYOUT_MARKERS.content, values.content);

	// Nunjucks autoescapes `{{ }}` output. Its escaper and escapeHtml() agree
	// on & < > " and differ only on the apostrophe (`&#39;` vs `&#039;`) —
	// different bytes, identical meaning — so the fixtures below exercise the
	// first four and leave apostrophes out of the byte comparison.
	out = out.replaceAll(LAYOUT_MARKERS.canonicalUrl, escapeHtml(values.canonicalUrl));
	out = out.replaceAll(LAYOUT_MARKERS.title, escapeHtml(values.title));
	out = out.replaceAll(LAYOUT_MARKERS.description, escapeHtml(values.description));
	out = out.replaceAll(LAYOUT_MARKERS.year, escapeHtml(values.year));

	expect(out, 'unsubstituted Nunjucks left in the rendered layout').not.toMatch(/\{[{%]/);
	return out;
}

/** Slices out an element by tag name, inclusive of both tags. */
function section(html: string, tag: 'head' | 'footer'): string {
	const start = html.indexOf(`<${tag}>`);
	const end = html.indexOf(`</${tag}>`);
	expect(start, `<${tag}> missing`).toBeGreaterThan(-1);
	expect(end, `</${tag}> missing`).toBeGreaterThan(start);
	return html.slice(start, end + tag.length + 3);
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * Values a real page could carry, deliberately containing characters that must
 * be escaped, so the comparison covers the escaping path and not just the
 * literal chrome.
 */
const values: PageValues = {
	title: 'Rooms & Rides <Beta>',
	description: 'Share a "room" & a ride with <academics> at the same conference.',
	canonicalUrl: 'https://researchroomies.com/search?q=acl&tag=cs',
	head: '',
	content: '<section><h2>Results</h2></section>',
	year: String(new Date().getFullYear()),
};

const workerPage = renderFullPage(values.title, values.content, {
	description: values.description,
	canonicalUrl: values.canonicalUrl,
});

describe('page shell', () => {
	it('has a committed layout that matches the generator', () => {
		expect(
			layoutSource,
			'templates/layouts/base.njk is stale — run `npm run build` (scripts/gen-layout.mjs)',
		).toBe(renderLayoutTemplate());
	});

	it('renders byte-identical <head> from the static layout and the Worker', () => {
		const staticPage = renderStaticPage(values);
		expect(section(staticPage, 'head')).toBe(section(workerPage, 'head'));
	});

	it('renders byte-identical <footer> from the static layout and the Worker', () => {
		const staticPage = renderStaticPage(values);
		expect(section(staticPage, 'footer')).toBe(section(workerPage, 'footer'));
	});

	it('renders a byte-identical whole document, nav included', () => {
		// The nav is the part that actually drifted once: renderFullPage() lost
		// #nav-user-state and Worker pages showed no login state for weeks.
		const staticPage = renderStaticPage(values);
		expect(staticPage).toBe(workerPage);

		for (const page of [staticPage, workerPage]) {
			expect(page).toContain(
				'<span id="nav-user-state" hx-get="/api/components/nav-user" hx-trigger="load" hx-swap="outerHTML"></span>',
			);
			expect(page).toContain(
				'<span id="nav-subjects" hx-get="/api/components/nav-subjects" hx-trigger="load" hx-swap="outerHTML"></span>',
			);
		}
	});

	it('renders Worker pages through the same function that generates the layout', () => {
		expect(workerPage).toBe(
			renderShell({
				title: values.title,
				description: values.description,
				canonicalUrl: values.canonicalUrl,
				content: values.content,
				year: values.year,
			}),
		);
	});

	it('declares the document type exactly once per page', () => {
		expect(occurrences(layoutSource, '<!DOCTYPE html>')).toBe(1);
		expect(occurrences(workerPage, '<!DOCTYPE html>')).toBe(1);
	});

	it('appends the site name to a bare title with one separator', () => {
		expect(renderFullPage('About', '')).toContain('<title>About – ResearchRoomies</title>');
		expect(layoutSource).toContain('<title>{{ title }} – ResearchRoomies</title>');
		// Pages used to write their own suffix, seven with a hyphen and two with
		// an en dash. Only the shell writes it now, and only one way.
		expect(layoutSource).not.toContain('- ResearchRoomies');
	});

	it('escapes the title into both <title> and og:title', () => {
		const page = renderFullPage('Rooms & Rides', '');
		expect(page).toContain('<title>Rooms &amp; Rides – ResearchRoomies</title>');
		expect(page).toContain('<meta property="og:title" content="Rooms &amp; Rides – ResearchRoomies" />');
	});

	it('fills the footer year rather than leaving it blank', () => {
		const year = new Date().getFullYear();
		expect(renderFullPage('About', '')).toContain(`© ${year} ResearchRoomies.`);
		// The static side gets the same value from Eleventy global data; the bug
		// was that the layout referenced a `year` nothing ever defined.
		expect(layoutSource).toContain('© {{ year }} ResearchRoomies.');
	});

	it('omits description and canonical tags when the caller supplies none', () => {
		const bare = renderFullPage('Edit Post', '<p>form</p>');
		expect(bare).not.toContain('name="description"');
		expect(bare).not.toContain('og:description');
		expect(bare).not.toContain('og:url');
		expect(bare).not.toContain('rel="canonical"');
		// Tags that do not depend on per-page data stay put.
		expect(bare).toContain('<meta property="og:type" content="website" />');
		expect(bare).toContain('<meta name="twitter:card" content="summary" />');
	});

	it('keeps the per-page head slot working when a page fills it', () => {
		const withHead = renderStaticPage({ ...values, head: '<style>.login {}</style>' });
		expect(withHead).toContain('<style>.login {}</style>');
		expect(section(withHead, 'footer')).toBe(section(workerPage, 'footer'));
	});

	it('loads the stylesheet, HTMX and Turnstile on every page', () => {
		const staticPage = renderStaticPage(values);
		for (const page of [staticPage, workerPage]) {
			expect(page).toContain('<link rel="stylesheet" href="/style/style.css" />');
			expect(page).toContain('https://cdn.jsdelivr.net/npm/htmx.org@2.0.7/dist/htmx.min.js');
			expect(page).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
		}
	});
});
