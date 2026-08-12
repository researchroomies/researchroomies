import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../src/routes';

/**
 * Guards the invariants Task 6 established, which are otherwise only prose:
 *
 *   A. No route module imports another route module. This is the rule that
 *      keeps the split from quietly re-collapsing: the moment posts.ts imports
 *      a renderer from conferences.ts, the files are one unit again with extra
 *      steps. Anything two route modules both need belongs in lib/ or db/.
 *
 *   B. No route module grows back into api.ts. It reached 1,199 lines — 37% of
 *      all TypeScript in src/ — one handler at a time, and nothing failed while
 *      it happened.
 *
 *   C. Every exported handler is registered in src/routes.ts. The split moved
 *      14 handlers between files; a handler that arrived nowhere would be dead
 *      code that still typechecks, and its route a silent 404.
 *
 * These run in the plain node vitest project (see vitest.config.mts) because
 * workerd has no node:fs.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = join(REPO_ROOT, 'src', 'routes');

/**
 * The bound is the task's "~300 lines". posts.ts is the largest at 303, so the
 * threshold sits a little above it: this is an alarm for a file becoming api.ts
 * again, not a style rule about the exact line count.
 */
const MAX_LINES = 320;

const ROUTE_MODULES = readdirSync(ROUTES_DIR)
	.filter((name) => name.endsWith('.ts'))
	.map((name) => relative(REPO_ROOT, join(ROUTES_DIR, name)).split('\\').join('/'))
	.sort();

/** Comments stripped before matching, as in the other guard tests — the doc comment above must not itself read as a cross-import. */
function code(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

it('finds the route modules it is supposed to be checking', () => {
	// A guard test that silently matches nothing is worse than no test.
	expect(ROUTE_MODULES).toContain('src/routes/posts.ts');
	expect(ROUTE_MODULES).toContain('src/routes/post-detail.ts');
	expect(ROUTE_MODULES.length).toBeGreaterThanOrEqual(8);
	// api.ts was the subject of the task; it should be gone, not merely smaller.
	expect(ROUTE_MODULES).not.toContain('src/routes/api.ts');
});

describe('A. route modules do not import each other', () => {
	it.each(ROUTE_MODULES)('%s imports only from lib/ and db/', (file) => {
		const specifiers = [...code(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
		const siblings = specifiers.filter((s) => /^\.\/[\w.-]+$/.test(s) || s.startsWith('../routes/'));

		expect(
			siblings,
			`${file} imports another route module (${siblings.join(', ')}). ` +
				`Anything two route modules both need belongs in src/lib/ or src/db/ — ` +
				`not in a sibling, and not in a shared render.ts grab bag.`,
		).toEqual([]);
	});
});

describe('B. no route module grows back into api.ts', () => {
	it.each(ROUTE_MODULES)('%s stays under the size bound', (file) => {
		const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n').length;
		expect(
			lines,
			`${file} is ${lines} lines, over the ${MAX_LINES}-line bound. api.ts got to ` +
				`1,199 this way. Split it along the same seams — by concern, following ` +
				`the src/db/ modules — rather than raising this number.`,
		).toBeLessThanOrEqual(MAX_LINES);
	});
});

describe('C. every exported handler is registered', () => {
	const REGISTERED = new Set(ROUTES.map((route) => route.handler.name));

	const EXPORTED = ROUTE_MODULES.flatMap((file) =>
		[...code(file).matchAll(/export\s+async\s+function\s+(handle\w+)/g)].map((m) => ({ file, name: m[1] })),
	);

	it('found the handlers to check', () => {
		expect(EXPORTED.length).toBe(ROUTES.length);
	});

	it.each(EXPORTED.map(({ file, name }) => [name, file] as const))(
		'%s (%s) appears in ROUTES',
		(name, file) => {
			expect(
				REGISTERED.has(name),
				`${name} is exported from ${file} but not registered in src/routes.ts, ` +
					`so its route is a 404 and the handler is dead code that still typechecks.`,
			).toBe(true);
		},
	);
});
