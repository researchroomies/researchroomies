import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createExecutionContext, fetchMock } from 'cloudflare:test';
import { handleReportForm, handleReportSubmit } from '../src/routes/flags';
import { handleDeletePostSubmit } from '../src/routes/posts';
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
 * Reports: what a `flags` row records, who may make one, and that it survives
 * the post it is about.
 *
 * As in inquiries.test.ts, net connect is disabled, so a test with no Mailgun
 * interceptor is also asserting that no admin email was attempted.
 */

const ctx = () => createExecutionContext();
const AUTHOR = 'author@university.edu';
const REPORTER = 'reporter@university.edu';

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
	const authorId = await seedUser(AUTHOR);
	const reporterId = await seedUser(REPORTER);
	const conferenceId = await seedConference({ userId: authorId, name: 'Topology Workshop', slug: 'topology-workshop', ...UPCOMING });
	const postId = await seedPost({ userId: authorId, conferenceId, title: 'Cheap room', description: 'Wire the deposit first.' });
	return {
		postId,
		authorId,
		authorCookie: await sessionCookie(authorId, AUTHOR),
		reporterCookie: await sessionCookie(reporterId, REPORTER),
	};
}

function report(postId: number, cookie: string) {
	return handleReportSubmit(
		testRequest(`/post/${postId}/report`, {
			cookie,
			form: { reason: 'Scam or fraud', details: 'Asks for a wire transfer.', 'cf-turnstile-response': 'token' },
		}),
		testEnv,
		ctx(),
		{ id: String(postId) },
	);
}

function form(postId: number, cookie: string) {
	return handleReportForm(testRequest(`/post/${postId}/report`, { cookie }), testEnv, ctx(), { id: String(postId) });
}

interface FlagRow {
	post_id: number;
	reason: string;
	flagged_by: string;
	post_title: string;
	post_description: string;
	post_user_id: number;
	notified_at: number | null;
}

async function flags(): Promise<FlagRow[]> {
	const { results } = await testEnv.DB.prepare(
		'SELECT post_id, reason, flagged_by, post_title, post_description, post_user_id, notified_at FROM flags ORDER BY id',
	).all<FlagRow>();
	return results;
}

describe('making a report', () => {
	it('records it with a copy of the post and marks the admin notified', async () => {
		const { postId, authorId, reporterCookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(200);

		const response = await report(postId, reporterCookie);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Report received');
		const [flag] = await flags();
		expect(flag).toMatchObject({
			post_id: postId,
			reason: 'Scam or fraud: Asks for a wire transfer.',
			flagged_by: REPORTER,
			post_title: 'Cheap room',
			post_description: 'Wire the deposit first.',
			post_user_id: authorId,
		});
		expect(flag.notified_at).toEqual(expect.any(Number));
	});

	it('still records it when the admin email fails, and leaves it un-notified', async () => {
		const { postId, reporterCookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(500);

		const response = await report(postId, reporterCookie);

		expect(response.status).toBe(200);
		const [flag] = await flags();
		expect(flag.notified_at).toBeNull();
	});
});

describe('reporting the same post twice', () => {
	it('records and emails only the first', async () => {
		const { postId, reporterCookie } = await fixture();
		expectTurnstile(true, 2);
		expectMailgun(200);

		await report(postId, reporterCookie);
		const second = await report(postId, reporterCookie);

		expect(second.status).toBe(200);
		expect(await second.text()).toContain('Already reported');
		expect(await flags()).toHaveLength(1);
	});

	it('shows "already reported" instead of the form', async () => {
		const { postId, reporterCookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(200);
		await report(postId, reporterCookie);

		const html = await (await form(postId, reporterCookie)).text();

		expect(html).toContain('Already reported');
		expect(html).not.toContain('Submit report');
	});

	it('does not stop a different reader reporting it', async () => {
		const { postId, reporterCookie } = await fixture();
		const otherId = await seedUser('other@university.edu');
		expectTurnstile(true, 2);
		expectMailgun(200);
		expectMailgun(200);

		await report(postId, reporterCookie);
		await report(postId, await sessionCookie(otherId, 'other@university.edu'));

		expect((await flags()).map((flag) => flag.flagged_by)).toEqual([REPORTER, 'other@university.edu']);
	});
});

describe('reporting your own post', () => {
	it('is refused on submit, with nothing recorded or emailed', async () => {
		const { postId, authorCookie } = await fixture();
		expectTurnstile(true);

		const response = await report(postId, authorCookie);

		expect(response.status).toBe(403);
		expect(await flags()).toEqual([]);
	});

	it('is refused on the form', async () => {
		const { postId, authorCookie } = await fixture();

		const response = await form(postId, authorCookie);

		expect(response.status).toBe(403);
	});
});

describe('a report outlives its post', () => {
	it('keeps the copy of what was reported after the author deletes the post', async () => {
		// The reason flags lost their foreign key: deleting the post used to delete
		// the reports, so a reported author could erase them.
		const { postId, authorCookie, reporterCookie } = await fixture();
		expectTurnstile(true);
		expectMailgun(200);
		await report(postId, reporterCookie);

		const deleted = await handleDeletePostSubmit(
			testRequest(`/post/${postId}/delete`, { method: 'POST', cookie: authorCookie }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(deleted.status).toBe(303);
		const [flag] = await flags();
		expect(flag).toMatchObject({ post_title: 'Cheap room', post_description: 'Wire the deposit first.' });
	});
});
