import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createExecutionContext, fetchMock } from 'cloudflare:test';
import {
	handleCreatePost,
	handleDeletePostSubmit,
	handleEditPostSubmit,
	handleMyPosts,
} from '../src/routes/posts';
import { getPost, getPostWithConference } from '../src/db/posts';
import { getConferenceBySlug } from '../src/db/conferences';
import { listTagsForConference } from '../src/db/tags';
import { recordFlag, recordMessage } from '../src/db/moderation';
import {
	expectTurnstile,
	resetDatabase,
	seedConference,
	seedPost,
	seedUser,
	sessionCookie,
	testEnv,
	testRequest,
	ts,
} from './helpers/seed';

/**
 * Handler tests against the real in-process D1.
 *
 * These are the point of Task 3, not a bonus: before it, every handler reached
 * into `env.DB` with raw SQL, so exercising one meant standing up a database by
 * hand and there were zero handler tests. What they cover is the behaviour that
 * only shows up when HTTP and SQL meet — that a refusal really writes nothing,
 * that an edit really lands on the right row, that a delete really takes the
 * flags with it.
 */

const ctx = () => createExecutionContext();

beforeEach(async () => {
	await resetDatabase();
	// Nothing here may reach the network: .dev.vars holds live credentials, and
	// two of these handlers verify Turnstile against Cloudflare.
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

async function countPosts(): Promise<number> {
	const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>();
	return row?.n ?? 0;
}

describe('handleCreatePost', () => {
	async function author() {
		const userId = await seedUser('prof@university.edu');
		const conferenceId = await seedConference({
			userId,
			name: 'Quantum Computing Summit',
			slug: 'quantum-computing-summit',
			start: '2026-03-01',
			stop: '2026-03-05',
		});
		return { userId, conferenceId, cookie: await sessionCookie(userId) };
	}

	it('creates a post against an existing conference and sends the author to /my-posts', async () => {
		const { userId, conferenceId, cookie } = await author();
		expectTurnstile(true);

		const response = await handleCreatePost(
			testRequest('/api/posts/create', {
				cookie,
				form: {
					conference_id: String(conferenceId),
					title: 'Roommate wanted',
					description: 'Sharing a hotel room near the venue',
					'cf-turnstile-response': 'token',
				},
			}),
			testEnv,
			ctx(),
		);

		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('https://researchroomies.com/my-posts');

		const row = await testEnv.DB.prepare('SELECT * FROM posts').first<{
			title: string;
			description: string;
			user_id: number;
			conference_id: number;
		}>();
		expect(row).toMatchObject({
			title: 'Roommate wanted',
			description: 'Sharing a hotel room near the venue',
			user_id: userId,
			conference_id: conferenceId,
		});
	});

	it('creates the conference too when asked, with a slug from its name', async () => {
		const { cookie } = await author();
		expectTurnstile(true);

		const response = await handleCreatePost(
			testRequest('/api/posts/create', {
				cookie,
				form: {
					conference_id: 'new',
					title: 'Carpool',
					description: 'Driving up Monday',
					new_conf_name: 'Marine Biology Congress',
					new_conf_start: '2026-06-10',
					new_conf_end: '2026-06-15',
					new_conf_city: 'San Diego',
					new_conf_state: 'CA',
					'cf-turnstile-response': 'token',
				},
			}),
			testEnv,
			ctx(),
		);

		expect(response.status).toBe(303);
		const conference = await getConferenceBySlug(testEnv, 'marine-biology-congress');
		expect(conference).toMatchObject({
			name: 'Marine Biology Congress',
			// City and state are stored as one free-text field.
			location_address: 'San Diego, CA',
			start_time: ts('2026-06-10'),
			stop_time: ts('2026-06-15'),
		});
	});

	it('suffixes a slug that is already taken rather than colliding', async () => {
		const { userId, cookie } = await author();
		await seedConference({
			userId,
			name: 'Marine Biology Congress',
			slug: 'marine-biology-congress',
			start: '2025-06-10',
			stop: '2025-06-15',
		});
		expectTurnstile(true);

		await handleCreatePost(
			testRequest('/api/posts/create', {
				cookie,
				form: {
					conference_id: 'new',
					title: 'Carpool',
					description: 'Driving up Monday',
					new_conf_name: 'Marine Biology Congress',
					new_conf_start: '2026-06-10',
					new_conf_end: '2026-06-15',
					'cf-turnstile-response': 'token',
				},
			}),
			testEnv,
			ctx(),
		);

		// The first conference keeps its slug; the newer one is still reachable.
		expect(await getConferenceBySlug(testEnv, 'marine-biology-congress')).toMatchObject({
			start_time: ts('2025-06-10'),
		});
		expect(await getConferenceBySlug(testEnv, 'marine-biology-congress-2')).toMatchObject({
			start_time: ts('2026-06-10'),
		});
	});

	it('keeps only tags from the curated list', async () => {
		const { cookie } = await author();
		expectTurnstile(true);

		await handleCreatePost(
			testRequest('/api/posts/create', {
				cookie,
				form: {
					conference_id: 'new',
					title: 'Carpool',
					description: 'Driving up Monday',
					new_conf_name: 'Marine Biology Congress',
					new_conf_start: '2026-06-10',
					new_conf_end: '2026-06-15',
					// The second is not in `tags`, so it must not create one.
					conf_tags: ['biology', 'not-a-real-subject'],
					'cf-turnstile-response': 'token',
				},
			}),
			testEnv,
			ctx(),
		);

		const conference = await getConferenceBySlug(testEnv, 'marine-biology-congress');
		const tags = await listTagsForConference(testEnv, conference!.id);
		expect(tags.map((tag) => tag.slug)).toEqual(['biology']);
	});

	it('refuses an unverified request and writes nothing', async () => {
		const { conferenceId, cookie } = await author();
		expectTurnstile(false);

		const response = await handleCreatePost(
			testRequest('/api/posts/create', {
				cookie,
				form: {
					conference_id: String(conferenceId),
					title: 'Roommate wanted',
					description: 'Sharing a hotel room',
					'cf-turnstile-response': 'bad-token',
				},
			}),
			testEnv,
			ctx(),
		);

		expect(response.status).toBe(400);
		expect(await countPosts()).toBe(0);
	});

	it('refuses a request with no Turnstile token at all, without calling siteverify', async () => {
		// A missing token is a failure, not a skip — so there is no interceptor
		// here, and afterEach would fail if the handler tried to verify one.
		const { conferenceId, cookie } = await author();

		const response = await handleCreatePost(
			testRequest('/api/posts/create', {
				cookie,
				form: {
					conference_id: String(conferenceId),
					title: 'Roommate wanted',
					description: 'Sharing a hotel room',
				},
			}),
			testEnv,
			ctx(),
		);

		expect(response.status).toBe(400);
		expect(await countPosts()).toBe(0);
	});

	it('refuses an anonymous request before looking at the form', async () => {
		const { conferenceId } = await author();

		const response = await handleCreatePost(
			testRequest('/api/posts/create', {
				form: {
					conference_id: String(conferenceId),
					title: 'Roommate wanted',
					description: 'Sharing a hotel room',
					'cf-turnstile-response': 'token',
				},
			}),
			testEnv,
			ctx(),
		);

		expect(response.status).toBe(401);
		expect(await countPosts()).toBe(0);
	});
});

describe('handleMyPosts', () => {
	it('lists the caller’s posts and nobody else’s', async () => {
		const mine = await seedUser('prof@university.edu');
		const theirs = await seedUser('other@university.edu');
		const conferenceId = await seedConference({
			userId: mine,
			name: 'Quantum Computing Summit',
			slug: 'quantum-computing-summit',
			start: '2026-03-01',
			stop: '2026-03-05',
		});
		await seedPost({ userId: mine, conferenceId, title: 'My own post', description: 'x' });
		await seedPost({ userId: theirs, conferenceId, title: 'Somebody else post', description: 'y' });

		const response = await handleMyPosts(
			testRequest('/my-posts', { cookie: await sessionCookie(mine) }),
			testEnv,
			ctx(),
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('My own post');
		expect(html).not.toContain('Somebody else post');
	});

	it('shows the empty state rather than an error when there are none', async () => {
		const userId = await seedUser('prof@university.edu');

		const response = await handleMyPosts(
			testRequest('/my-posts', { cookie: await sessionCookie(userId) }),
			testEnv,
			ctx(),
		);

		expect(await response.text()).toContain("You haven't created any posts yet");
	});

	it('sends an anonymous visitor to the login page', async () => {
		const response = await handleMyPosts(testRequest('/my-posts'), testEnv, ctx());

		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toBe('https://researchroomies.com/login');
	});
});

/** The edit and delete handlers share their fixture: one post, two users. */
async function ownedPost() {
	const owner = await seedUser('prof@university.edu');
	const stranger = await seedUser('other@university.edu');
	const conferenceId = await seedConference({
		userId: owner,
		name: 'Quantum Computing Summit',
		slug: 'quantum-computing-summit',
		start: '2026-03-01',
		stop: '2026-03-05',
	});
	const postId = await seedPost({
		userId: owner,
		conferenceId,
		title: 'Original title',
		description: 'Original description',
	});
	return {
		postId,
		ownerCookie: await sessionCookie(owner, 'prof@university.edu'),
		strangerCookie: await sessionCookie(stranger, 'other@university.edu'),
	};
}

describe('handleEditPostSubmit', () => {
	it('saves the author’s changes and returns to the post', async () => {
		const { postId, ownerCookie } = await ownedPost();

		const response = await handleEditPostSubmit(
			testRequest(`/post/${postId}/edit`, {
				cookie: ownerCookie,
				form: { title: 'Updated title', description: 'Updated description' },
			}),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe(`https://researchroomies.com/post/${postId}`);
		expect(await getPost(testEnv, postId)).toMatchObject({
			title: 'Updated title',
			description: 'Updated description',
		});
	});

	it('refuses somebody else’s post and leaves it untouched', async () => {
		const { postId, strangerCookie } = await ownedPost();

		const response = await handleEditPostSubmit(
			testRequest(`/post/${postId}/edit`, {
				cookie: strangerCookie,
				form: { title: 'Hijacked', description: 'Hijacked' },
			}),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(response.status).toBe(403);
		expect(await getPost(testEnv, postId)).toMatchObject({ title: 'Original title' });
	});

	it('404s an id that names nothing', async () => {
		const { ownerCookie } = await ownedPost();

		const response = await handleEditPostSubmit(
			testRequest('/post/9999/edit', {
				cookie: ownerCookie,
				form: { title: 'x', description: 'y' },
			}),
			testEnv,
			ctx(),
			{ id: '9999' },
		);

		expect(response.status).toBe(404);
	});

	it('404s a malformed id rather than resolving it to another row', async () => {
		// parseInt("12abc") is 12, which is why parseRouteId() exists.
		const { postId, ownerCookie } = await ownedPost();

		const response = await handleEditPostSubmit(
			testRequest(`/post/${postId}abc/edit`, {
				cookie: ownerCookie,
				form: { title: 'Hijacked', description: 'Hijacked' },
			}),
			testEnv,
			ctx(),
			{ id: `${postId}abc` },
		);

		expect(response.status).toBe(404);
		expect(await getPost(testEnv, postId)).toMatchObject({ title: 'Original title' });
	});

	it('rejects an empty title without clearing the stored one', async () => {
		const { postId, ownerCookie } = await ownedPost();

		const response = await handleEditPostSubmit(
			testRequest(`/post/${postId}/edit`, {
				cookie: ownerCookie,
				form: { title: '   ', description: 'Updated description' },
			}),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(response.status).toBe(400);
		expect(await getPost(testEnv, postId)).toMatchObject({
			title: 'Original title',
			description: 'Original description',
		});
	});
});

describe('handleDeletePostSubmit', () => {
	it('deletes the post and the flags that reference it', async () => {
		const { postId, ownerCookie } = await ownedPost();
		await recordFlag(testEnv, {
			postId,
			reason: 'Spam or advertising',
			flaggedBy: 'reporter@university.edu',
			timestamp: ts('2026-02-01'),
		});

		const response = await handleDeletePostSubmit(
			testRequest(`/post/${postId}/delete`, { method: 'POST', cookie: ownerCookie }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('https://researchroomies.com/my-posts');
		expect(await getPostWithConference(testEnv, postId)).toBeNull();

		const flags = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM flags').first<{ n: number }>();
		expect(flags?.n).toBe(0);
	});

	it('keeps the record of inquiries that were already sent', async () => {
		const { postId, ownerCookie } = await ownedPost();
		await recordMessage(testEnv, {
			postId,
			senderEmail: 'asker@university.edu',
			recipientEmail: 'prof@university.edu',
			content: 'Is the room still available?',
			timestamp: ts('2026-02-01'),
		});

		await handleDeletePostSubmit(
			testRequest(`/post/${postId}/delete`, { method: 'POST', cookie: ownerCookie }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(await getPost(testEnv, postId)).toBeNull();
		const messages = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM message').first<{ n: number }>();
		expect(messages?.n).toBe(1);
	});

	it('refuses somebody else’s post and leaves it in place', async () => {
		const { postId, strangerCookie } = await ownedPost();

		const response = await handleDeletePostSubmit(
			testRequest(`/post/${postId}/delete`, { method: 'POST', cookie: strangerCookie }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(response.status).toBe(403);
		expect(await getPost(testEnv, postId)).not.toBeNull();
	});
});
