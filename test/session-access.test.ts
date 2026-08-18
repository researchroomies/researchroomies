import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the invariants Task 2 established, which are otherwise only prose:
 *
 *   A. Session resolution goes through src/lib/guards.ts. If a handler can call
 *      getSessionUser() directly it can also invent its own fourth answer to
 *      "not logged in", which is exactly the state this task cleaned up.
 *
 *   B. No handler re-implements the ownership comparison by hand. It was three
 *      steps written out four times, and forgetting the middle one is silent.
 *
 *   C. The login route verifies Turnstile through lib/turnstile.ts rather than
 *      its own siteverify fetch. That module exists to make "a missing token is
 *      a failure, not a skip" unforgettable; routing around it once already
 *      shipped a bypass.
 *
 * These run in the plain node vitest project (see vitest.config.mts) because
 * workerd has no node:fs.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(REPO_ROOT, 'src');

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return entry.isFile() && /\.(ts|mjs)$/.test(entry.name) ? [full] : [];
	});
}

/** Repo-relative, forward-slashed, so assertion output is readable. */
const SOURCES = sourceFiles(SRC_DIR).map((file) => relative(REPO_ROOT, file).split('\\').join('/'));

/**
 * Comments are stripped before matching, because every rule below is documented
 * at the site that obeys it — the comment explaining why routes/auth.ts no
 * longer hand-rolls siteverify must not itself read as a hand-rolled siteverify.
 *
 * `//` only starts a comment when it is not preceded by `:`, so the `//` in
 * `https://…` survives: a URL is the one thing these greps must never lose.
 */
function code(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

it('finds the source files it is supposed to be checking', () => {
	// A guard test that silently matches nothing is worse than no test.
	expect(SOURCES).toContain('src/lib/guards.ts');
	expect(SOURCES).toContain('src/routes/posts.ts');
	expect(SOURCES.length).toBeGreaterThan(10);
});

describe('A. getSessionUser() is reached only through lib/guards.ts', () => {
	/**
	 * src/lib/session.ts declares it. src/lib/guards.ts is the one wrapper.
	 * src/routes/auth.ts is the documented exception: handleAuthMe reports the
	 * raw session as its entire purpose, so there is no guard decision to make.
	 */
	const ALLOWED = ['src/lib/session.ts', 'src/lib/guards.ts', 'src/routes/auth.ts'];

	it.each(SOURCES.filter((file) => !ALLOWED.includes(file)))('%s does not mention getSessionUser', (file) => {
		expect(code(file)).not.toMatch(/getSessionUser/);
	});

	it('the exception in routes/auth.ts is still the single handleAuthMe call', () => {
		const source = code('src/routes/auth.ts');
		// Once in the import, once in handleAuthMe. A third would be a new call site.
		expect(source.match(/getSessionUser/g)).toHaveLength(2);
	});

	it('guards.ts offers both a required and an optional path, so neither has to be hand-rolled', () => {
		const source = code('src/lib/guards.ts');
		expect(source).toMatch(/export async function requireUser/);
		expect(source).toMatch(/export async function optionalUser/);
	});
});

describe('B. ownership is checked by the guard, not by hand', () => {
	it('routes/posts.ts contains no explicit user_id comparison', () => {
		expect(code('src/routes/posts.ts')).not.toMatch(/user_id\s*!==/);
	});

	it('the comparison lives in guards.ts instead', () => {
		expect(code('src/lib/guards.ts')).toMatch(/post\.user_id !== sessionUserId\(user\)/);
	});

	it('the defence-in-depth AND user_id = ? clauses survive on the mutations', () => {
		// The SQL moved to src/db/posts.ts in Task 3; the invariant did not. The
		// guard makes these clauses redundant, not wrong — a bug in it must not
		// become a way to edit or delete someone else's post.
		const source = code('src/db/posts.ts');
		// `[\s\S]*?` rather than `.*`: the UPDATE gained columns and wrapped onto
		// several lines when position and institution became editable. The clause
		// being asserted did not move — only the selector had to.
		expect(source).toMatch(/UPDATE\s+posts\s+SET [\s\S]*?WHERE id = \? AND user_id = \?/);
		expect(source).toMatch(/DELETE FROM posts WHERE id = \? AND user_id = \?/);
	});

	it('the mutating handlers still pass the session user id through to them', () => {
		// The clause only defends anything if the value bound to it comes from the
		// session rather than from the request.
		const source = code('src/routes/posts.ts');
		expect(source).toMatch(/updatePost\(env, post\.id, sessionUserId\(user\)/);
		expect(source).toMatch(/deletePostAndFlags\(env, post\.id, sessionUserId\(user\)\)/);
	});
});

describe('C. Turnstile verification has one implementation', () => {
	it('only lib/turnstile.ts knows the siteverify endpoint', () => {
		for (const file of SOURCES.filter((f) => f !== 'src/lib/turnstile.ts')) {
			expect(code(file), `${file} should call verifyTurnstile() instead`).not.toMatch(/siteverify/);
		}
	});

	it('routes/auth.ts builds no Turnstile FormData of its own', () => {
		const source = code('src/routes/auth.ts');
		expect(source).not.toMatch(/new FormData/);
		expect(source).toMatch(/verifyTurnstile\(/);
	});
});
