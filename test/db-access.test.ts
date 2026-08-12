import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the invariants Task 3 established, which are otherwise only prose:
 *
 *   A. SQL lives in src/db/. A handler that can reach env.DB can also invent its
 *      own fifth spelling of a post row, which is the state this task cleaned
 *      up — 27 call sites holding ~28 statements, with a post's shape declared
 *      six different ways and none of them authoritative.
 *
 *   B. No `as unknown as` anywhere in src/. Four of them used to launder row
 *      types past the type checker; the clearest lie was `getAllConferences()`,
 *      typed `Promise<Conference[]>` over a `SELECT id, name`. D1's `.first<T>()`
 *      and `.all<T>()` generics are the supported way to say the same thing
 *      honestly, and every query in src/db/ uses them.
 *
 *   C. Row types are defined in src/db/types.ts rather than beside a query.
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

const DB_MODULES = SOURCES.filter((file) => file.startsWith('src/db/'));
const OUTSIDE_DB = SOURCES.filter((file) => !file.startsWith('src/db/'));

/**
 * Comments are stripped before matching, for the same reason as in
 * session-access.test.ts: every rule below is documented at the site that obeys
 * it, and the doc comment explaining which casts were deleted must not itself
 * read as a cast.
 */
function code(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

it('finds the source files it is supposed to be checking', () => {
	// A guard test that silently matches nothing is worse than no test.
	expect(SOURCES).toContain('src/routes/posts.ts');
	expect(DB_MODULES).toContain('src/db/posts.ts');
	expect(DB_MODULES.length).toBeGreaterThanOrEqual(5);
	expect(OUTSIDE_DB.length).toBeGreaterThan(10);
});

describe('A. SQL is reached only through src/db/', () => {
	it.each(OUTSIDE_DB)('%s does not prepare a statement', (file) => {
		expect(code(file)).not.toMatch(/DB\.prepare/);
	});

	it.each(OUTSIDE_DB)('%s does not batch statements', (file) => {
		expect(code(file)).not.toMatch(/DB\.batch/);
	});

	/**
	 * The looser check behind the two above: no SQL keyword at the head of a
	 * statement anywhere outside src/db/. It catches a query built as a string
	 * and handed to something other than DB.prepare.
	 */
	it.each(OUTSIDE_DB)('%s contains no SQL', (file) => {
		expect(code(file)).not.toMatch(/\b(SELECT\s+[\w*]|INSERT\s+(INTO|OR)|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
	});

	it('the db modules are where the SQL actually is', () => {
		const sql = DB_MODULES.filter((file) => /DB\.prepare/.test(code(file)));
		expect(sql.sort()).toEqual([
			'src/db/conferences.ts',
			'src/db/moderation.ts',
			'src/db/posts.ts',
			'src/db/tags.ts',
			'src/db/users.ts',
		]);
	});
});

describe('B. no cast launders a row type', () => {
	it.each(SOURCES)('%s contains no `as unknown as`', (file) => {
		expect(code(file)).not.toMatch(/as\s+unknown\s+as/);
	});

	/**
	 * Every read carries its row type as a D1 generic. An un-generic `.first()`
	 * or `.all()` yields `Record<string, unknown>`, and the pressure to make that
	 * usable is exactly what produced the four casts in the first place.
	 *
	 * One deliberate exception: `reserveSlug()` probes `SELECT 1` purely to ask
	 * whether a row exists and throws the row away, so there is no shape to name.
	 */
	it('every read in src/db/ names its row type', () => {
		const ungeneric = DB_MODULES.flatMap((file) => {
			const matches = code(file).match(/\.(first|all)\(/g) ?? [];
			return matches.map(() => file);
		});
		expect(ungeneric).toEqual(['src/db/conferences.ts']);
	});
});

describe('C. row shapes are declared once, in src/db/types.ts', () => {
	/**
	 * Interfaces elsewhere are fine — a viewer flag bag, a config shape. What must
	 * not come back is a *row* redeclared next to the query that reads it, which
	 * is how a post came to have six different shapes. These field names are the
	 * tell: they are database columns, so an interface declaring one is a row.
	 */
	const COLUMN_ISH = /^\s*(user_id|conference_id|conference_name|conference_slug|location_address|start_time|stop_time|created_at|last_login_at|flagged_by|post_count|tag_slug)\s*[?]?\s*:/m;

	it.each(SOURCES.filter((file) => file !== 'src/db/types.ts'))('%s declares no row shape', (file) => {
		const interfaces = code(file).match(/(?:interface|type)\s+\w+\s*=?\s*\{[^}]*\}/g) ?? [];
		for (const declaration of interfaces) {
			expect(declaration, `${file} should import this from src/db/types.ts`).not.toMatch(COLUMN_ISH);
		}
	});

	it('types.ts defines the shapes the rest of the app imports', () => {
		const source = code('src/db/types.ts');
		for (const name of [
			'Conference',
			'ConferenceListing',
			'ConferenceSummary',
			'ConferenceWithPostCount',
			'Post',
			'PostDetail',
			'PostWithConference',
			'Tag',
			'User',
		]) {
			expect(source).toMatch(new RegExp(`export interface ${name}\\b`));
		}
	});
});
