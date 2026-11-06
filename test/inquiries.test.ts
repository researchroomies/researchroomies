import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createExecutionContext, fetchMock } from 'cloudflare:test';
import { handleMessageSend, INQUIRY_DEDUPE_SECONDS } from '../src/routes/messages';
import { handlePostPage } from '../src/routes/post-detail';
import { settleMessage, startMessage } from '../src/db/messages';
import {
	expectTurnstile,
	resetDatabase,
	seedConference,
	seedPost,
	seedUser,
	sessionCookie,
	testEnv,
	testRequest,
	UPCOMING,
} from './helpers/seed';

/**
 * Inquiry delivery: a `message` row is written as 'pending' before the email
 * goes out and settled after, so that a retry can see the earlier attempt.
 *
 * The bug these guard against: the row used to be written after the send, so a
 * D1 error at that point showed a 500 for an email that had already gone out,
 * the user retried, and the author received it twice. Each test below pins one
 * transition of the row, or one way a retry is told apart from a new message.
 *
 * `fetchMock` runs with net connect disabled, so a test that installs no Mailgun
 * interceptor is also asserting the handler never sent anything: an unexpected
 * send fails inside sendMailgunMessage() and turns the answer into a 502.
 */

const ctx = () => createExecutionContext();
const SENDER = 'reader@university.edu';
const CONTENT = 'Is the room still available?';

beforeEach(async () => {
	await resetDatabase();
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

function expectMailgun(status: number): void {
	fetchMock
		.get('https://api.mailgun.net')
		.intercept({ path: /\/v3\/.*\/messages$/, method: 'POST' })
		.reply(status, status === 200 ? { id: 'test' } : 'mailgun says no');
}

async function fixture() {
	const authorId = await seedUser('author@university.edu');
	const readerId = await seedUser(SENDER);
	const conferenceId = await seedConference({ userId: authorId, name: 'Topology Workshop', slug: 'topology-workshop', ...UPCOMING });
	const postId = await seedPost({ userId: authorId, conferenceId, title: 'Splitting a room', description: 'Two beds.' });
	return { postId, cookie: await sessionCookie(readerId, SENDER) };
}

function send(postId: number, cookie: string, content = CONTENT, env: Env = testEnv) {
	return handleMessageSend(
		testRequest('/api/message/send', {
			cookie,
			form: { post_id: String(postId), content, 'cf-turnstile-response': 'token' },
		}),
		env,
		ctx(),
	);
}

async function rows() {
	const { results } = await testEnv.DB.prepare(
		'SELECT status, content, typeof(content) AS content_type FROM message ORDER BY id',
	).all<{ status: string; content: string; content_type: string }>();
	return results;
}

/** A copy of testEnv whose DB throws on any statement matching `pattern`. */
function failingOn(pattern: RegExp): Env {
	const db = testEnv.DB;
	const proxy = new Proxy(db, {
		get(target, prop) {
			if (prop === 'prepare') {
				return (sql: string) => {
					if (pattern.test(sql)) throw new Error('simulated D1 failure');
					return target.prepare(sql);
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return { ...testEnv, DB: proxy };
}

describe('sending an inquiry', () => {
	it('records it as sent and redirects to the confirmation', async () => {
		const { postId, cookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(200);

		const response = await send(postId, cookie);

		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe(`https://researchroomies.com/post/${postId}?sent=1`);
		expect((await rows()).map((row) => row.status)).toEqual(['sent']);
	});

	it('stores a digits-only message as text, not as a number', async () => {
		// The baseline declared `content STRING`, which SQLite gives NUMERIC
		// affinity: "0123" would have come back as the integer 123.
		const { postId, cookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(200);

		await send(postId, cookie, '0123');

		const [row] = await rows();
		expect(row.content_type).toBe('text');
		expect(row.content).toBe('0123');
	});
});

describe('when the mail provider fails', () => {
	it('says nothing was sent and records the attempt as failed', async () => {
		const { postId, cookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(500);

		const response = await send(postId, cookie);

		expect(response.status).toBe(502);
		expect(await response.text()).toContain('Nothing was sent, so it is safe to try again');
		expect((await rows()).map((row) => row.status)).toEqual(['failed']);
	});

	it('lets the retry through, because a failed attempt is not a sent one', async () => {
		const { postId, cookie } = await fixture();
		expectTurnstile(true, 2);
		expectMailgun(500);
		expectMailgun(200);

		await send(postId, cookie);
		const retry = await send(postId, cookie);

		expect(retry.status).toBe(303);
		expect((await rows()).map((row) => row.status)).toEqual(['failed', 'sent']);
	});
});

describe('when D1 fails', () => {
	it('before the send: shows an error and sends nothing', async () => {
		// No Mailgun interceptor. Reaching the mailer would fail the assertion
		// below with a 502 rather than the 500 this path returns.
		const { postId, cookie } = await fixture();
		expectTurnstile(true);

		const response = await send(postId, cookie, CONTENT, failingOn(/INSERT INTO message/));

		expect(response.status).toBe(500);
		expect(await rows()).toEqual([]);
	});

	it('after the send: still reports success, because the email went out', async () => {
		// The bug this whole change exists for. A 500 here is what made people
		// retry an inquiry the author had already received.
		const { postId, cookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(200);

		const response = await send(postId, cookie, CONTENT, failingOn(/UPDATE message/));

		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toContain('?sent=1');
		expect((await rows()).map((row) => row.status)).toEqual(['pending']);
	});
});

describe('retrying the same inquiry', () => {
	it('does not send again after a success', async () => {
		const { postId, cookie } = await fixture();
		expectTurnstile(true, 2);
		expectMailgun(200);

		await send(postId, cookie);
		const retry = await send(postId, cookie);

		expect(retry.status).toBe(303);
		expect(await rows()).toHaveLength(1);
	});

	it('does not send again while an earlier attempt is still pending', async () => {
		// A Worker that died between Mailgun accepting and the row settling leaves
		// 'pending' behind. The email most likely went out, so it counts as sent.
		const { postId, cookie } = await fixture();
		await startMessage(testEnv, {
			postId,
			senderEmail: SENDER,
			recipientEmail: 'author@university.edu',
			content: CONTENT,
			timestamp: Math.floor(Date.now() / 1000) - 60,
		});
		expectTurnstile(true);

		const retry = await send(postId, cookie);

		expect(retry.status).toBe(303);
		expect((await rows()).map((row) => row.status)).toEqual(['pending']);
	});

	it('sends a different message to the same author', async () => {
		const { postId, cookie } = await fixture();
		expectTurnstile(true, 2);
		expectMailgun(200);
		expectMailgun(200);

		await send(postId, cookie);
		await send(postId, cookie, 'Also, is parking included?');

		expect((await rows()).map((row) => row.status)).toEqual(['sent', 'sent']);
	});

	it('sends the same words again once the window has passed', async () => {
		const { postId, cookie } = await fixture();
		const id = await startMessage(testEnv, {
			postId,
			senderEmail: SENDER,
			recipientEmail: 'author@university.edu',
			content: CONTENT,
			timestamp: Math.floor(Date.now() / 1000) - INQUIRY_DEDUPE_SECONDS - 60,
		});
		await settleMessage(testEnv, id, 'sent');
		expectTurnstile(true);
		expectMailgun(200);

		await send(postId, cookie);

		expect((await rows()).map((row) => row.status)).toEqual(['sent', 'sent']);
	});
});

describe('settling a message', () => {
	it('only ever moves a pending row', async () => {
		const { postId } = await fixture();
		const id = await startMessage(testEnv, {
			postId,
			senderEmail: SENDER,
			recipientEmail: 'author@university.edu',
			content: CONTENT,
			timestamp: Math.floor(Date.now() / 1000),
		});

		await settleMessage(testEnv, id, 'sent');
		await settleMessage(testEnv, id, 'failed');

		expect((await rows()).map((row) => row.status)).toEqual(['sent']);
	});
});

describe('the "your inquiry was sent" notice', () => {
	const NOTICE = 'Your inquiry was sent.';

	async function page(postId: number, cookie: string) {
		const response = await handlePostPage(
			testRequest(`/post/${postId}?sent=1`, { cookie }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);
		return await response.text();
	}

	it('appears when the viewer really sent one', async () => {
		const { postId, cookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(200);
		await send(postId, cookie);

		expect(await page(postId, cookie)).toContain(NOTICE);
	});

	it('does not appear from the URL alone', async () => {
		const { postId, cookie } = await fixture();

		expect(await page(postId, cookie)).not.toContain(NOTICE);
	});

	it('does not appear after a failed send', async () => {
		const { postId, cookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(500);
		await send(postId, cookie);

		expect(await page(postId, cookie)).not.toContain(NOTICE);
	});
});
