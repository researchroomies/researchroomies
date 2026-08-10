import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../src/routes';

/**
 * Guards the two invariants that were previously maintained by prose in
 * CLAUDE.md, and that have each broken in production:
 *
 *   A. No Eleventy build output shadows a registered Worker route. Cloudflare
 *      serves a matching static asset BEFORE invoking the Worker, so when
 *      templates/pages/search.njk built to public/search/index.html, GET /search
 *      silently stopped running and served a stale shell instead.
 *
 *   B. Every registered route is listed in run_worker_first in wrangler.toml,
 *      which is the belt-and-braces version of (A): it forces the Worker to run
 *      even if an asset does appear at that path.
 *
 * These run in the plain node vitest project (see vitest.config.mts) because
 * workerd has no node:fs.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(REPO_ROOT, 'public');
const WRANGLER_TOML = join(REPO_ROOT, 'wrangler.toml');

/**
 * public/ is a build output and is gitignored, so it is absent on a fresh
 * clone and in any CI job that forgets to build. Both tests below would then
 * pass vacuously — a guard test that no-ops is worse than no test — so every
 * one of them goes through here and fails loudly instead.
 */
function requirePublicDir(): string {
	if (!existsSync(PUBLIC_DIR) || !statSync(PUBLIC_DIR).isDirectory()) {
		throw new Error(
			`public/ is missing at ${PUBLIC_DIR}. These are guard tests over the ` +
				`Eleventy build output and cannot run without it — run \`npm run build\` ` +
				`(or \`npm run check\`, which builds first) and try again.`,
		);
	}
	return PUBLIC_DIR;
}

/** Unique route paths; several methods share one path. */
const ROUTE_PATHS = [...new Set(ROUTES.map((route) => route.path))].sort();

/**
 * The literal prefix of a route, i.e. everything before its first `:param`
 * segment. `/post/:id/edit` and `/post/:id` both reduce to `/post`; a route
 * with no params is its own prefix.
 */
function literalPrefix(routePath: string): { prefix: string; hasParam: boolean } {
	const segments = routePath.split('/').filter(Boolean);
	const paramIndex = segments.findIndex((segment) => segment.startsWith(':'));
	if (paramIndex === -1) return { prefix: routePath, hasParam: false };
	return { prefix: '/' + segments.slice(0, paramIndex).join('/'), hasParam: true };
}

describe('build output does not shadow a Worker route', () => {
	it('has a built public/ to check against', () => {
		expect(() => requirePublicDir()).not.toThrow();
	});

	it.each(ROUTE_PATHS)('%s is not shadowed by an asset', (routePath) => {
		const publicDir = requirePublicDir();
		const { prefix, hasParam } = literalPrefix(routePath);
		const relative = prefix.replace(/^\//, '');

		if (hasParam) {
			// A param route owns everything under its prefix, so any directory
			// Eleventy builds there is a collision. templates/pages/conference.njk
			// producing public/conference/index.html is exactly this case.
			const dir = join(publicDir, relative);
			expect(
				existsSync(dir) && statSync(dir).isDirectory(),
				`public/${relative}/ exists and shadows the route ${routePath}. ` +
					`Delete the template that builds it, or the Worker will never run.`,
			).toBe(false);
			return;
		}

		// Eleventy emits directory-style pages (foo.njk -> public/foo/index.html);
		// the flat form is what a passthrough copy or permalink would produce.
		for (const candidate of [join(relative, 'index.html'), `${relative}.html`]) {
			expect(
				existsSync(join(publicDir, candidate)),
				`public/${candidate} exists and shadows the route ${routePath}. ` +
					`Delete the template that builds it, or the Worker will never run.`,
			).toBe(false);
		}
	});
});

/**
 * Mirrors generateGlobOnlyRuleRegExp() in Cloudflare's asset router (vendored
 * in miniflare as workers-shared/asset-worker/src/utils/rules-engine.ts): the
 * rule is anchored at both ends and `*` becomes `.*`, so a wildcard DOES cross
 * `/` — `/post/*` covers `/post/1/edit`.
 */
const ESCAPE_REGEX_CHARACTERS = /[-/\\^$*+?.()|[\]{}]/g;

function ruleToRegExp(rule: string): RegExp {
	const source = rule
		.split('*')
		.map((part) => part.replace(ESCAPE_REGEX_CHARACTERS, '\\$&'))
		.join('.*');
	return new RegExp(`^${source}$`);
}

/**
 * wrangler splits run_worker_first into two lists: rules starting with `!/`
 * force the asset worker and are checked first, everything else forces the
 * user Worker. Reproduced here so the test agrees with the runtime.
 */
function parseRunWorkerFirst(): { userWorker: string[]; assetWorker: string[] } {
	if (!existsSync(WRANGLER_TOML)) {
		throw new Error(`wrangler.toml is missing at ${WRANGLER_TOML}.`);
	}
	const toml = readFileSync(WRANGLER_TOML, 'utf8');
	const match = toml.match(/^[ \t]*run_worker_first[ \t]*=[ \t]*\[([^\]]*)\]/m);
	if (!match) {
		throw new Error(
			'Could not find an array-valued `run_worker_first` in wrangler.toml. ' +
				'Every Worker route must be listed there or a future Eleventy page ' +
				'can silently shadow it.',
		);
	}
	const rules = [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
	return {
		userWorker: rules.filter((rule) => !rule.startsWith('!')),
		assetWorker: rules.filter((rule) => rule.startsWith('!/')).map((rule) => rule.slice(1)),
	};
}

/** A concrete pathname for a route pattern: /post/:id -> /post/sample. */
function samplePath(routePath: string): string {
	return routePath.replace(/:\w+/g, 'sample');
}

describe('run_worker_first covers every route', () => {
	const { userWorker, assetWorker } = parseRunWorkerFirst();

	it('declares at least one rule', () => {
		expect(userWorker.length).toBeGreaterThan(0);
	});

	it.each(ROUTE_PATHS)('%s is claimed by run_worker_first', (routePath) => {
		const pathname = samplePath(routePath);

		const forcedToAssets = assetWorker.find((rule) => ruleToRegExp(rule).test(pathname));
		expect(
			forcedToAssets,
			`${pathname} matches the negative rule "!${forcedToAssets}" in ` +
				`run_worker_first, which sends it to static assets instead of the Worker.`,
		).toBeUndefined();

		const claimed = userWorker.some((rule) => ruleToRegExp(rule).test(pathname));
		expect(
			claimed,
			`No run_worker_first rule matches ${pathname} (route ${routePath}). ` +
				`Add a covering pattern to [assets].run_worker_first in wrangler.toml — ` +
				`rules are anchored and "*" matches across "/", so "/post/*" covers ` +
				`"/post/1/edit". Current rules: ${JSON.stringify(userWorker)}`,
		).toBe(true);
	});
});
