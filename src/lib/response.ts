import { escapeHtml, renderFullPage, type PageOptions } from './html';

/**
 * Cache policy, picked from a menu rather than retyped as a header string.
 *
 * Responses used to be built by hand at 41 sites, which meant the charset was
 * written two different ways and the cache policy was re-decided per handler —
 * nothing stopped a session-varying fragment from being cached publicly.
 * Adding a member here is a deliberate act; typing `max-age=` in a handler is
 * no longer possible.
 */
export type Cache = 'public-short' | 'public-long' | 'private' | 'none';

const CACHE_CONTROL: Record<Cache, string> = {
	/** Content that changes with the database but not with the viewer. */
	'public-short': 'public, max-age=300',
	/** Near-static reference data (the tag list). */
	'public-long': 'public, max-age=3600',
	/** Anything whose body depends on who is asking. The default. */
	private: 'private, no-cache',
	/** Query results and error pages — never worth reusing. */
	none: 'no-store',
};

/**
 * Written once, so it cannot drift. Previously 29 sites said "text/html" and 12
 * said "text/html; charset=utf-8".
 */
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

export interface ResponseOptions {
	status?: number;
	/**
	 * Defaults to 'private'. Public caching is opt-in: getting this wrong on a
	 * response that varies by session leaks one viewer's page to the next.
	 */
	cache?: Cache;
}

/** The primitive every other function here goes through. */
export function htmlResponse(body: string, opts: ResponseOptions = {}): Response {
	return new Response(body, {
		status: opts.status ?? 200,
		headers: {
			'Content-Type': HTML_CONTENT_TYPE,
			'Cache-Control': CACHE_CONTROL[opts.cache ?? 'private'],
		},
	});
}

/** Wraps content in renderFullPage() and returns it. */
export function pageResponse(
	title: string,
	content: string,
	opts: PageOptions & ResponseOptions = {},
): Response {
	const { status, cache, ...page } = opts;
	return htmlResponse(renderFullPage(title, content, page), { status, cache });
}

/**
 * For /api/components/* — a raw HTML fragment with no page chrome.
 *
 * Same wire format as htmlResponse(); the separate name is what makes the
 * "is this fragment session-varying?" question get asked at the call site.
 */
export function fragmentResponse(html: string, opts: ResponseOptions = {}): Response {
	return htmlResponse(html, opts);
}

/**
 * 404. `what` names the missing entity and becomes the heading, e.g.
 * notFoundPage('Post') → "Post Not Found".
 */
export function notFoundPage(what = 'Page'): Response {
	const heading = `${escapeHtml(what)} Not Found`;
	return pageResponse(
		`${what} Not Found`,
		`<div class="site-page"><h1>${heading}</h1><p>The requested ${escapeHtml(what.toLowerCase())} could not be found. <a href="/search">Browse all posts</a> instead.</p></div>`,
		{ status: 404, cache: 'none' },
	);
}

/** 403. `reason` is developer-authored copy, never an exception or user input. */
export function forbiddenPage(reason = 'You do not have permission to do that.'): Response {
	return pageResponse(
		'Forbidden',
		`<div class="site-page"><h1>Forbidden</h1><p>${escapeHtml(reason)}</p></div>`,
		{ status: 403, cache: 'none' },
	);
}

/**
 * 500. Takes no arguments on purpose.
 *
 * A handler once returned "Internal Server Error: " + err.message, which put
 * D1 constraint and table names in front of the client. There is no parameter
 * here to put them in — log the error, return this.
 */
export function errorPage(): Response {
	return pageResponse(
		'Error',
		`<div class="site-page"><h1>Error</h1><p>Something went wrong. Please try again later.</p></div>`,
		{ status: 500, cache: 'none' },
	);
}
