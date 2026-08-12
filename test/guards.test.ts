import { describe, it, expect } from 'vitest';
import { generateSessionToken } from '../src/lib/auth';
import { COOKIE_NAME } from '../src/lib/session';
import { requireUser, optionalUser, type GuardMode } from '../src/lib/guards';

/**
 * The three failure modes are the risk in this refactor: a handler that quietly
 * moves from 302 to 401 breaks a page navigation, and one that moves from
 * HX-Redirect to 302 swaps the entire login page into a <div>. The matrix below
 * is every mode against every way a session can be absent.
 */

const SECRET = 'test-secret-must-be-at-least-32-chars-long-so-here-is-some-padding';
const ENV = { AUTH_HMAC_SECRET: SECRET } as unknown as Env;
const URL_UNDER_TEST = 'https://researchroomies.com/my-posts';

const MODES: GuardMode[] = ['page', 'api', 'htmx'];

function request(cookie?: string): Request {
	return new Request(URL_UNDER_TEST, {
		headers: cookie ? { Cookie: cookie } : {},
	});
}

async function validCookie(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const token = await generateSessionToken(now, 'prof@university.edu', '42', SECRET, 3600);
	return `${COOKIE_NAME}=${token}`;
}

async function expiredCookie(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	// A negative TTL puts `exp` in the past, which is what verifySessionToken
	// rejects on — no clock mocking needed.
	const token = await generateSessionToken(now, 'prof@university.edu', '42', SECRET, -60);
	return `${COOKIE_NAME}=${token}`;
}

/** Signed with a different secret: right shape, wrong signature. */
async function forgedCookie(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const token = await generateSessionToken(now, 'attacker@example.com', '1', `${SECRET}_wrong`, 3600);
	return `${COOKIE_NAME}=${token}`;
}

/** Every way a request can arrive without a usable session. */
const ANONYMOUS: Array<[string, () => Promise<string | undefined>]> = [
	['no cookie header at all', async () => undefined],
	['a cookie header with no session cookie', async () => 'other=value'],
	['a malformed token', async () => `${COOKIE_NAME}=not-a-token`],
	['a token with a valid shape but no signature', async () => `${COOKIE_NAME}=eyJhIjoxfQ`],
	['a forged token', forgedCookie],
	['an expired token', expiredCookie],
];

describe('requireUser', () => {
	describe.each(MODES)('mode %s', (mode) => {
		it.each(ANONYMOUS)('refuses %s', async (_label, cookie) => {
			const guard = await requireUser(request(await cookie()), ENV, mode);
			expect(guard.ok).toBe(false);
		});

		it('admits a valid token and hands back the payload', async () => {
			const guard = await requireUser(request(await validCookie()), ENV, mode);
			expect(guard.ok).toBe(true);
			if (!guard.ok) return;
			expect(guard.value.sub).toBe('42');
			expect(guard.value.email).toBe('prof@university.edu');
		});
	});

	// The point of the whole task: one condition, three deliberate answers.
	describe('failure shapes', () => {
		it("'page' redirects to /login so the browser lands on the login form", async () => {
			const guard = await requireUser(request(), ENV, 'page');
			expect(guard.ok).toBe(false);
			if (guard.ok) return;
			expect(guard.response.status).toBe(302);
			expect(guard.response.headers.get('Location')).toBe('https://researchroomies.com/login');
		});

		it("'api' refuses with a bare 401", async () => {
			const guard = await requireUser(request(), ENV, 'api');
			expect(guard.ok).toBe(false);
			if (guard.ok) return;
			expect(guard.response.status).toBe(401);
			expect(await guard.response.text()).toBe('Unauthorized');
		});

		it("'htmx' returns 200 with HX-Redirect — a 302 here would swap the login page into a fragment", async () => {
			const guard = await requireUser(request(), ENV, 'htmx');
			expect(guard.ok).toBe(false);
			if (guard.ok) return;
			expect(guard.response.status).toBe(200);
			expect(guard.response.headers.get('HX-Redirect')).toBe('/login');
			expect(await guard.response.text()).toBe('');
		});

		it('never sets Location on the non-page modes', async () => {
			for (const mode of ['api', 'htmx'] as const) {
				const guard = await requireUser(request(), ENV, mode);
				if (guard.ok) throw new Error('expected refusal');
				expect(guard.response.headers.get('Location')).toBeNull();
			}
		});
	});
});

describe('optionalUser', () => {
	it('returns null for an anonymous request rather than a Response', async () => {
		expect(await optionalUser(request(), ENV)).toBeNull();
	});

	it('returns null for an expired token', async () => {
		expect(await optionalUser(request(await expiredCookie()), ENV)).toBeNull();
	});

	it('returns the payload for a valid token', async () => {
		const user = await optionalUser(request(await validCookie()), ENV);
		expect(user?.sub).toBe('42');
	});
});
