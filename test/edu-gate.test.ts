import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createExecutionContext, fetchMock } from 'cloudflare:test';
import { handleAuthStart, handleAuthCallback } from '../src/routes/auth';
import { generateMagicLinkToken, EDU_RESTRICTION_MESSAGE } from '../src/lib/auth';
import { expectTurnstile, resetDatabase, testEnv } from './helpers/seed';

/**
 * The .edu gate as the two HTTP surfaces it actually has.
 *
 * `isEmailAllowed` is unit-tested in auth_verification.test.ts; this file is
 * about the contract the login page is written against, which the predicate
 * alone does not pin down:
 *
 *   - a refused address gets **403**, and 403 from /api/auth/start means the
 *     gate and nothing else. The login page dispatches on exactly that status
 *     to raise its dialog, so any other handler growing a 403 here would put
 *     the wrong words in front of a user;
 *   - the 403 body is the message verbatim, because the page shows the body it
 *     receives rather than carrying its own copy of the text;
 *   - a refused address is refused *before* the mailer is reached, so no login
 *     email is ever sent to an address that cannot log in;
 *   - the callback refuses too, which is what makes flipping the flag on take
 *     effect immediately rather than after the last issued link expires.
 *
 * Both flag states are passed explicitly. Reading RESTRICT_EDU_EMAILS out of
 * wrangler.toml would make these assertions flip meaning the next time the
 * deployment decision changes, which is the opposite of a guard.
 */

const ctx = () => createExecutionContext();

const gate = (on: boolean): Env => ({ ...testEnv, RESTRICT_EDU_EMAILS: on ? 'true' : 'false' }) as Env;

function startRequest(email: string): Request {
	return new Request('https://researchroomies.com/api/auth/start', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, cf_turnstile_response: 'token' }),
	});
}

async function callbackRequest(email: string, env: Env): Promise<Request> {
	const token = await generateMagicLinkToken(email, env.AUTH_HMAC_SECRET, 600);
	return new Request(
		`https://researchroomies.com/api/auth/callback?token=${encodeURIComponent(token)}`,
	);
}

beforeEach(async () => {
	await resetDatabase();
	// Nothing here may reach the network — .dev.vars holds a live Mailgun key,
	// and "did this try to send mail?" is one of the things being asserted.
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe('POST /api/auth/start with the gate on', () => {
	it('refuses a non-.edu address with 403 and the message as the body', async () => {
		expectTurnstile(true);

		const response = await handleAuthStart(startRequest('someone@gmail.com'), gate(true), ctx());

		expect(response.status).toBe(403);
		expect(await response.text()).toBe(EDU_RESTRICTION_MESSAGE);
	});

	it('refuses before sending mail, so no email reaches a blocked address', async () => {
		expectTurnstile(true);

		// No Mailgun interceptor is registered. fetchMock has net connect
		// disabled, so a send attempt fails the request rather than escaping —
		// and afterEach's assertNoPendingInterceptors catches the reverse.
		const response = await handleAuthStart(startRequest('someone@gmail.com'), gate(true), ctx());

		expect(response.status).toBe(403);
	});

	it('still runs Turnstile first — the gate is not a way around the bot check', async () => {
		const response = await handleAuthStart(startRequest('prof@university.edu'), gate(true), ctx());

		// No siteverify interceptor, so verifyTurnstile() fails: a 400, not the
		// 502/200 that would mean the handler had gone on to the mailer.
		expect(response.status).toBe(400);
	});

	it('lets a .edu address through to the mailer', async () => {
		expectTurnstile(true);
		fetchMock
			.get('https://api.mailgun.net')
			.intercept({ path: /\/v3\/.*\/messages$/, method: 'POST' })
			.reply(200, { id: 'test' });

		const response = await handleAuthStart(startRequest('prof@university.edu'), gate(true), ctx());

		expect(response.status).toBe(200);
	});
});

describe('POST /api/auth/start with the gate off', () => {
	it('does not 403 a non-.edu address — the dialog must stay unreachable', async () => {
		expectTurnstile(true);
		fetchMock
			.get('https://api.mailgun.net')
			.intercept({ path: /\/v3\/.*\/messages$/, method: 'POST' })
			.reply(200, { id: 'test' });

		const response = await handleAuthStart(startRequest('someone@gmail.com'), gate(false), ctx());

		expect(response.status).not.toBe(403);
	});
});

describe('GET /api/auth/callback', () => {
	it('refuses a link already issued to a non-.edu address once the gate is on', async () => {
		const env = gate(true);
		const response = await handleAuthCallback(await callbackRequest('someone@gmail.com', env), env, ctx());

		expect(response.status).toBe(403);
		expect(await response.text()).toContain(EDU_RESTRICTION_MESSAGE);
	});

	it('creates no user for the address it just refused', async () => {
		const env = gate(true);
		await handleAuthCallback(await callbackRequest('someone@gmail.com', env), env, ctx());

		const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
		expect(row?.n).toBe(0);
	});

	it('signs a .edu address in', async () => {
		const env = gate(true);
		const response = await handleAuthCallback(await callbackRequest('prof@university.edu', env), env, ctx());

		expect(response.status).toBe(302);
		expect(response.headers.get('Set-Cookie')).toContain('rr_session=');
	});
});
