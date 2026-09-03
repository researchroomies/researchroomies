import { env, fetchMock } from 'cloudflare:test';
import { generateSessionToken } from '../../src/lib/auth';
import { COOKIE_NAME } from '../../src/lib/session';
import { createConference } from '../../src/db/conferences';
import { createPost } from '../../src/db/posts';
import { upsertUserOnLogin } from '../../src/db/users';

/**
 * Fixtures for the handler tests, against the real D1 that
 * @cloudflare/vitest-pool-workers provides in process.
 *
 * Deliberately a real database rather than a fake `env.DB`. The risk this task
 * carries is a *SQL* mistake — a binding pushed in the wrong order, a filter
 * that silently matches everything — and a fake that returns whatever rows the
 * test hands it cannot fail on any of those. Here the query is really planned
 * and really executed, so a wrong `?` produces a wrong row set the assertions
 * catch.
 *
 * Seeding goes through the src/db/ write functions rather than raw INSERTs, so
 * the fixtures exercise the same interface the handlers use.
 */

/**
 * The real migration chain, in order — the same files
 * `wrangler d1 migrations apply` runs.
 *
 * Reading migrations/ rather than a separate schema file is what keeps this
 * suite honest: there is one definition of the database, and a migration that
 * does not produce a working schema fails the tests instead of failing on
 * deploy. It also means the tests exercise the tag rename, so the post-migration
 * slugs are the ones every assertion sees.
 *
 * Sorted by filename, which is what the `NNNN_` prefix is for.
 */
const MIGRATIONS = import.meta.glob('../../migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true,
}) as Record<string, string>;

/** `;` also appears inside `--` comments, so strip those before splitting. */
function statementsIn(sql: string): string[] {
	return sql
		.replace(/^\s*--.*$/gm, '')
		.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean);
}

/**
 * The chain as files, newest last — not one concatenated blob.
 *
 * A migration is applied at most once per database here, recorded in the same
 * `d1_migrations` table `wrangler d1 migrations apply` uses, because that is
 * what the real thing does and because re-running is not harmless. Every
 * statement up to 0003 was `CREATE TABLE IF NOT EXISTS` or an upsert, so a blob
 * re-applied on each reset happened to be a no-op; `ALTER TABLE ... ADD COLUMN`
 * has no `IF NOT EXISTS` form and fails outright the second time. Tracking is
 * the honest fix: production applies each file once, so the tests do too.
 *
 * The tracking table lives in the same storage as the schema, so whichever way
 * the pool's isolation is configured the two are rolled back together and can
 * never disagree.
 */
const MIGRATION_FILES = Object.keys(MIGRATIONS)
	.sort()
	.map((path) => ({ name: path.split('/').pop() as string, statements: statementsIn(MIGRATIONS[path]) }));

const TEST_SECRET = 'test-secret-must-be-at-least-32-chars-long-so-here-is-some-padding';

export const testEnv: Env = {
	...env,
	AUTH_HMAC_SECRET: TEST_SECRET,
	TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
};

/**
 * Applies any unapplied migration and empties every table the tests write to.
 *
 * The deletes make each test independent of whatever ran before it regardless
 * of how the pool's storage isolation is configured. `tags`, `share_types` and
 * `positions` keep their seeded rows — they are curated lists, not test data.
 */
export async function resetDatabase(): Promise<void> {
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
	).run();
	const { results } = await env.DB.prepare(`SELECT name FROM d1_migrations`).all<{ name: string }>();
	const applied = new Set((results ?? []).map((row) => row.name));

	for (const migration of MIGRATION_FILES) {
		if (applied.has(migration.name)) continue;
		for (const statement of migration.statements) {
			await env.DB.prepare(statement).run();
		}
		await env.DB.prepare(`INSERT INTO d1_migrations (name) VALUES (?)`).bind(migration.name).run();
	}

	await env.DB.batch([
		env.DB.prepare('DELETE FROM flags'),
		env.DB.prepare('DELETE FROM message'),
		env.DB.prepare('DELETE FROM conference_tags'),
		env.DB.prepare('DELETE FROM post_share_types'),
		env.DB.prepare('DELETE FROM posts'),
		env.DB.prepare('DELETE FROM conferences'),
		env.DB.prepare('DELETE FROM users'),
	]);
}

/** Midnight UTC for a `YYYY-MM-DD` date, in the Unix seconds the schema stores. */
export function ts(date: string): number {
	return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

/**
 * A `YYYY-MM-DD` date `days` from today, for fixtures whose behaviour depends on
 * whether the conference is over.
 *
 * Archiving is a comparison against the wall clock (see src/lib/archive.ts), so
 * a fixture written as a literal date is a test that passes until that date goes
 * by and then fails for a reason nobody will connect to it. Every conference in
 * this suite that must be live, or must be finished, says which relative to now.
 */
export function dateFromNow(days: number): string {
	const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	return date.toISOString().slice(0, 10);
}

/** A conference far enough ahead that nothing in the suite can archive it. */
export const UPCOMING = { start: dateFromNow(30), stop: dateFromNow(34) };

/** A conference far enough behind that it is unambiguously archived. */
export const FINISHED = { start: dateFromNow(-34), stop: dateFromNow(-30) };

export async function seedUser(email: string): Promise<number> {
	return await upsertUserOnLogin(testEnv, email, ts('2026-01-01'));
}

export async function seedConference(input: {
	userId: number;
	name: string;
	slug: string;
	locationAddress?: string | null;
	start: string;
	stop: string;
}): Promise<number> {
	return await createConference(testEnv, {
		userId: input.userId,
		name: input.name,
		slug: input.slug,
		locationAddress: input.locationAddress ?? null,
		startTime: ts(input.start),
		stopTime: ts(input.stop),
		createdAt: ts('2026-01-01'),
	});
}

/**
 * A post. Position and institution default to null, i.e. to a post written
 * before those fields existed.
 *
 * That is the deliberate default rather than a convenience: the columns are
 * nullable precisely because production is full of such rows, and a fixture
 * that always filled them in would let a renderer that cannot survive a null
 * pass the whole suite.
 */
export async function seedPost(input: {
	userId: number;
	conferenceId: number;
	title: string;
	description: string;
	createdAt?: number;
	position?: { slug: string; other: string | null } | null;
	institution?: string | null;
}): Promise<number> {
	return await createPost(testEnv, {
		userId: input.userId,
		conferenceId: input.conferenceId,
		title: input.title,
		description: input.description,
		createdAt: input.createdAt ?? ts('2026-01-02'),
		position: input.position ?? null,
		institution: input.institution ?? null,
	});
}

/** A signed session cookie header value for `userId`. */
export async function sessionCookie(userId: number, email = 'prof@university.edu'): Promise<string> {
	const token = await generateSessionToken(
		Math.floor(Date.now() / 1000),
		email,
		String(userId),
		TEST_SECRET,
		3600,
	);
	return `${COOKIE_NAME}=${token}`;
}

interface RequestOptions {
	method?: string;
	cookie?: string;
	form?: Record<string, string | string[]>;
}

/** A Request against the app origin, optionally signed in and carrying a form body. */
export function testRequest(path: string, options: RequestOptions = {}): Request {
	const headers: Record<string, string> = {};
	if (options.cookie) headers.Cookie = options.cookie;

	let body: FormData | undefined;
	if (options.form) {
		body = new FormData();
		for (const [key, value] of Object.entries(options.form)) {
			for (const entry of Array.isArray(value) ? value : [value]) body.append(key, entry);
		}
	}

	return new Request(`https://researchroomies.com${path}`, {
		method: options.method ?? (body ? 'POST' : 'GET'),
		headers,
		body,
	});
}

/**
 * Makes the next Turnstile siteverify call succeed or fail without touching the
 * network. Handlers that verify a token call this once per request.
 *
 * `fetchMock` is activated with net connect disabled in the test setup, so a
 * request this does not account for fails loudly rather than escaping to
 * Cloudflare.
 */
export function expectTurnstile(success: boolean, times = 1): void {
	fetchMock
		.get('https://challenges.cloudflare.com')
		.intercept({ path: '/turnstile/v0/siteverify', method: 'POST' })
		.reply(200, { success })
		.times(times);
}
