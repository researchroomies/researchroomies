import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createExecutionContext, fetchMock } from 'cloudflare:test';
import { handleCreatePost } from '../src/routes/create-post';
import { handleEditPostForm, handleEditPostSubmit, handleDeletePostSubmit } from '../src/routes/posts';
import { handleMessageSend } from '../src/routes/messages';
import { handlePostPage } from '../src/routes/post-detail';
import { handleConferencePage } from '../src/routes/conferences';
import { handleMyPosts } from '../src/routes/my-posts';
import { handleComponentConferenceOptions } from '../src/routes/components';
import { getPost } from '../src/db/posts';
import { ARCHIVE_GRACE_SECONDS, isArchivedStopTime, nowSeconds } from '../src/lib/archive';
import {
	expectTurnstile,
	resetDatabase,
	seedConference,
	seedPost,
	seedUser,
	sessionCookie,
	testEnv,
	testRequest,
	FINISHED,
	UPCOMING,
} from './helpers/seed';

/**
 * Archiving: what a conference closes when its last day has passed.
 *
 * The three things the feature promises — it drops out of the create-post
 * picker, its posts stop taking inquiries, its posts stop being editable — are
 * each asserted against a real archived row here rather than against the helper
 * alone. The helper is one comparison and is easy to get right; the risk is a
 * handler that never asks it, which only a request-level test can catch.
 *
 * Deleting an archived post is asserted to still work. That is a deliberate
 * asymmetry, not an oversight, and this is where it is written down.
 */

const ctx = () => createExecutionContext();

beforeEach(async () => {
	await resetDatabase();
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe('the cutoff itself', () => {
	it('keeps a conference live through the whole of its last day', () => {
		// stop_time is midnight UTC at the *start* of the last day, so a
		// conference whose closing session is today must not archive this morning.
		const now = nowSeconds();

		expect(isArchivedStopTime(now, now)).toBe(false);
		expect(isArchivedStopTime(now - ARCHIVE_GRACE_SECONDS + 1, now)).toBe(false);
	});

	it('archives it once that day is fully behind us', () => {
		const now = nowSeconds();

		expect(isArchivedStopTime(now - ARCHIVE_GRACE_SECONDS, now)).toBe(true);
		expect(isArchivedStopTime(now - 30 * ARCHIVE_GRACE_SECONDS, now)).toBe(true);
	});
});

/** One finished conference and one upcoming one, with a post on each. */
async function bothConferences() {
	const owner = await seedUser('prof@university.edu');
	const finished = await seedConference({
		userId: owner,
		name: 'Topology Workshop',
		slug: 'topology-workshop',
		...FINISHED,
	});
	const upcoming = await seedConference({
		userId: owner,
		name: 'Quantum Computing Summit',
		slug: 'quantum-computing-summit',
		...UPCOMING,
	});
	const archivedPost = await seedPost({
		userId: owner,
		conferenceId: finished,
		title: 'Room at the topology workshop',
		description: 'Two nights near the venue',
	});
	const livePost = await seedPost({
		userId: owner,
		conferenceId: upcoming,
		title: 'Room at the summit',
		description: 'Four nights near the venue',
	});
	return {
		owner,
		finished,
		upcoming,
		archivedPost,
		livePost,
		cookie: await sessionCookie(owner),
	};
}

describe('the create-post picker', () => {
	it('offers upcoming conferences and not finished ones', async () => {
		const { upcoming } = await bothConferences();

		const response = await handleComponentConferenceOptions(
			testRequest('/api/components/conference-options'),
			testEnv,
			ctx(),
		);
		const html = await response.text();

		expect(html).toContain(`<option value="${upcoming}">Quantum Computing Summit</option>`);
		expect(html).not.toContain('Topology Workshop');
		// Creating a new one is always available; that is the branch archiving
		// does not close.
		expect(html).toContain('<option value="new">Create New Conference</option>');
	});
});

describe('creating a post', () => {
	async function create(form: Record<string, string>, cookie: string) {
		return await handleCreatePost(
			testRequest('/api/post', {
				cookie,
				form: {
					position_slug: 'professor',
					institution: 'State University',
					title: 'Roommate wanted',
					description: 'Sharing a hotel room near the venue',
					'cf-turnstile-response': 'token',
					...form,
				},
			}),
			testEnv,
			ctx(),
		);
	}

	it('refuses a conference that has already finished, and writes nothing', async () => {
		// The id comes from a form body, so a filtered <option> list is not the
		// check — this is the one that actually holds.
		const { finished, cookie } = await bothConferences();
		expectTurnstile(true);

		const response = await create({ conference_id: String(finished) }, cookie);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('already finished');

		const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE title = ?')
			.bind('Roommate wanted')
			.first<{ n: number }>();
		expect(row?.n).toBe(0);
	});

	it('still accepts a conference that has not', async () => {
		const { upcoming, cookie } = await bothConferences();
		expectTurnstile(true);

		const response = await create({ conference_id: String(upcoming) }, cookie);

		expect(response.status).toBe(303);
	});

	it('refuses to create a conference that is already over', async () => {
		// Otherwise the row would be archived the instant it existed, holding a
		// slug nobody can post against.
		const { cookie } = await bothConferences();
		expectTurnstile(true);

		const response = await create(
			{
				conference_id: 'new',
				new_conf_name: 'Retro Symposium',
				new_conf_start: FINISHED.start,
				new_conf_end: FINISHED.stop,
			},
			cookie,
		);

		expect(response.status).toBe(400);
		const conference = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM conferences WHERE slug = ?')
			.bind('retro-symposium')
			.first<{ n: number }>();
		expect(conference?.n).toBe(0);
	});
});

describe('editing an archived post', () => {
	it('refuses the form with a 403 that says why', async () => {
		const { archivedPost, cookie } = await bothConferences();

		const response = await handleEditPostForm(
			testRequest(`/post/${archivedPost}/edit`, { cookie }),
			testEnv,
			ctx(),
			{ id: String(archivedPost) },
		);

		expect(response.status).toBe(403);
		expect(await response.text()).toContain('This conference has ended');
	});

	it('refuses the save and leaves the post untouched', async () => {
		const { archivedPost, cookie } = await bothConferences();

		const response = await handleEditPostSubmit(
			testRequest(`/post/${archivedPost}/edit`, {
				cookie,
				form: { position_slug: 'professor', institution: 'State University', title: 'Rewritten', description: 'Rewritten' },
			}),
			testEnv,
			ctx(),
			{ id: String(archivedPost) },
		);

		expect(response.status).toBe(403);
		expect(await getPost(testEnv, archivedPost)).toMatchObject({
			title: 'Room at the topology workshop',
		});
	});

	it('still lets the author delete it', async () => {
		// The asymmetry archiving is built on: it stops a stale offer being
		// presented, and clearing one away is the opposite of that.
		const { archivedPost, cookie } = await bothConferences();

		const response = await handleDeletePostSubmit(
			testRequest(`/post/${archivedPost}/delete`, { method: 'POST', cookie }),
			testEnv,
			ctx(),
			{ id: String(archivedPost) },
		);

		expect(response.status).toBe(303);
		expect(await getPost(testEnv, archivedPost)).toBeNull();
	});

	it('leaves an upcoming conference\'s post editable', async () => {
		const { livePost, cookie } = await bothConferences();

		const response = await handleEditPostSubmit(
			testRequest(`/post/${livePost}/edit`, {
				cookie,
				form: { position_slug: 'professor', institution: 'State University', title: 'Rewritten', description: 'Rewritten' },
			}),
			testEnv,
			ctx(),
			{ id: String(livePost) },
		);

		expect(response.status).toBe(303);
		expect(await getPost(testEnv, livePost)).toMatchObject({ title: 'Rewritten' });
	});
});

describe('inquiries on an archived post', () => {
	it('are refused with a 403 and never reach the mail provider', async () => {
		// No Mailgun interceptor: afterEach fails the test if the handler tried.
		const { archivedPost } = await bothConferences();
		const readerId = await seedUser('reader@university.edu');
		expectTurnstile(true);

		const response = await handleMessageSend(
			testRequest('/api/message/send', {
				cookie: await sessionCookie(readerId, 'reader@university.edu'),
				form: {
					post_id: String(archivedPost),
					content: 'Is the room still available?',
					'cf-turnstile-response': 'token',
				},
			}),
			testEnv,
			ctx(),
		);

		expect(response.status).toBe(403);
		const messages = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM message').first<{ n: number }>();
		expect(messages?.n).toBe(0);
	});
});

describe('what the pages say', () => {
	async function postHtml(postId: number, cookie?: string): Promise<string> {
		const response = await handlePostPage(
			testRequest(`/post/${postId}`, cookie ? { cookie } : {}),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);
		expect(response.status).toBe(200);
		return await response.text();
	}

	it('replaces the inquiry form with a closed notice', async () => {
		const { archivedPost } = await bothConferences();
		const readerId = await seedUser('reader@university.edu');

		const html = await postHtml(archivedPost, await sessionCookie(readerId, 'reader@university.edu'));

		expect(html).toContain('Inquiries are closed');
		expect(html).not.toContain('/api/message/send');
	});

	it('drops the author\'s Edit button but keeps Delete', async () => {
		const { archivedPost, cookie } = await bothConferences();

		const html = await postHtml(archivedPost, cookie);

		expect(html).not.toContain(`/post/${archivedPost}/edit`);
		expect(html).toContain(`/post/${archivedPost}/delete`);
	});

	it('leaves a live post\'s form and Edit button alone', async () => {
		const { livePost, cookie } = await bothConferences();

		const html = await postHtml(livePost, cookie);

		expect(html).toContain(`/post/${livePost}/edit`);
		expect(html).not.toContain('Inquiries are closed');
	});

	it('marks the finished conference page and stops inviting posts to it', async () => {
		await bothConferences();

		const response = await handleConferencePage(
			testRequest('/conference/topology-workshop'),
			testEnv,
			ctx(),
			{ slug: 'topology-workshop' },
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('This one has finished');
		expect(html).not.toContain('Post for this conference');
	});

	it('shows the author Archived instead of Edit in their own listing', async () => {
		const { archivedPost, livePost, cookie } = await bothConferences();

		const response = await handleMyPosts(testRequest('/my-posts', { cookie }), testEnv, ctx());
		const html = await response.text();

		expect(html).toContain('<span class="post-archived">Archived</span>');
		expect(html).not.toContain(`/post/${archivedPost}/edit`);
		expect(html).toContain(`/post/${livePost}/edit`);
		// Both are still listed; archiving hides nothing.
		expect(html).toContain('Room at the topology workshop');
	});
});
