import { describe, it, expect, beforeEach } from 'vitest';
import { createExecutionContext, fetchMock } from 'cloudflare:test';
import { handleEditPostForm, handleEditPostSubmit } from '../src/routes/posts';
import { handleCreatePost } from '../src/routes/create-post';
import { handlePostPage } from '../src/routes/post-detail';
import { handleSearch } from '../src/routes/search';
import { listShareTypesForPost, listShareTypesForPosts, setShareTypesForPost } from '../src/db/share-types';
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
 * Share types: what a post is offering, as data rather than as prose.
 *
 * The case worth protecting is a post carrying *more than one* — a room and a
 * seat in the car — because that is the whole reason this is a join table and
 * not a column, and because every filter and renderer has to keep working when
 * a post matches two of them at once. A single-type post would pass a filter
 * written with `=` just as happily as one written with `IN`.
 *
 * The other half is the write: it replaces rather than adds. Unchecked boxes
 * submit nothing at all, so an add-only write (which is what the sibling
 * `tagConference()` does, deliberately) would make removing a share type
 * impossible while looking like it worked.
 */

const ctx = () => createExecutionContext();

let userId: number;
let conferenceId: number;

beforeEach(async () => {
	await resetDatabase();
	// handleCreatePost verifies Turnstile; nothing here may reach the network.
	fetchMock.activate();
	fetchMock.disableNetConnect();
	userId = await seedUser('prof@university.edu');
	conferenceId = await seedConference({
		userId,
		name: 'Quantum Computing Summit',
		slug: 'quantum-computing-summit',
		locationAddress: 'Boston, MA',
		...UPCOMING,
	});
});

async function slugsFor(postId: number): Promise<string[]> {
	return (await listShareTypesForPost(testEnv, postId)).map((type) => type.slug);
}

describe('a post can offer several things at once', () => {
	it('stores every checked box from the create form', async () => {
		expectTurnstile(true);

		const response = await handleCreatePost(
			testRequest('/api/post', {
				cookie: await sessionCookie(userId),
				form: {
					position_slug: 'professor',
					institution: 'State University',
					conference_id: String(conferenceId),
					title: 'Room and a ride',
					description: 'Splitting a double, and I have two seats in the car.',
					share_types: ['lodging', 'carpool'],
					'cf-turnstile-response': 'token',
				},
			}),
			testEnv,
			ctx(),
		);

		expect(response.status).toBe(303);

		const post = await testEnv.DB.prepare('SELECT id FROM posts WHERE title = ?')
			.bind('Room and a ride')
			.first<{ id: number }>();
		expect(await slugsFor(post!.id)).toEqual(['lodging', 'carpool']);
	});

	it('shows both as badges on the post page', async () => {
		const postId = await seedPost({ userId, conferenceId, title: 'Room and a ride', description: 'Both.' });
		await setShareTypesForPost(testEnv, postId, ['lodging', 'carpool']);

		const response = await handlePostPage(testRequest(`/post/${postId}`), testEnv, ctx(), {
			id: String(postId),
		});
		const html = await response.text();

		expect(html).toContain('>Lodging<');
		expect(html).toContain('>Carpool<');
	});

	it('returns them in the curated order, not insertion or alphabetical order', async () => {
		const postId = await seedPost({ userId, conferenceId, title: 'Backwards', description: 'x' });
		// This pair separates all three orderings: inserted carpool-first, it
		// sorts lodging-first by `sort_order` and carpool-first by name. Ordering
		// by either of the wrong two returns ['carpool', 'lodging'].
		await setShareTypesForPost(testEnv, postId, ['carpool', 'lodging']);

		expect(await slugsFor(postId)).toEqual(['lodging', 'carpool']);
	});
});

describe('the search filter tests membership, not equality', () => {
	let both: number;
	let lodgingOnly: number;
	let untyped: number;

	beforeEach(async () => {
		both = await seedPost({ userId, conferenceId, title: 'Room and a ride', description: 'x' });
		lodgingOnly = await seedPost({ userId, conferenceId, title: 'Just a room', description: 'x' });
		untyped = await seedPost({ userId, conferenceId, title: 'Predates the feature', description: 'x' });
		await setShareTypesForPost(testEnv, both, ['lodging', 'carpool']);
		await setShareTypesForPost(testEnv, lodgingOnly, ['lodging']);
	});

	async function search(query: string): Promise<string> {
		const response = await handleSearch(testRequest(`/search${query}`), testEnv, ctx());
		expect(response.status).toBe(200);
		return await response.text();
	}

	it('finds a multi-type post under each of its types', async () => {
		// The assertion that a `=` filter or a naive JOIN would fail: the post
		// offering two things has to answer to both questions.
		const byCarpool = await search('?share=carpool');
		expect(byCarpool).toContain('Room and a ride');
		expect(byCarpool).not.toContain('Just a room');

		const byLodging = await search('?share=lodging');
		expect(byLodging).toContain('Room and a ride');
		expect(byLodging).toContain('Just a room');
	});

	it('returns a multi-type post once, not once per matching row', async () => {
		const html = await search('?share=lodging');
		expect(html.split('Room and a ride').length - 1).toBe(1);
		expect(html).toContain('2 posts');
	});

	it('excludes posts with no share types from a filtered search', async () => {
		const html = await search('?share=lodging');
		expect(html).not.toContain('Predates the feature');
	});

	it('leaves untyped posts in an unfiltered search', async () => {
		const html = await search('');
		expect(html).toContain('Predates the feature');
		expect(untyped).toBeGreaterThan(0);
	});

	it('combines with the other filters rather than replacing them', async () => {
		// Both posts are lodging; only one matches the keyword. If the share
		// clause dropped the earlier bindings, this would return both.
		const html = await search('?share=lodging&q=Just');
		expect(html).toContain('Just a room');
		expect(html).not.toContain('Room and a ride');
	});

	it('an unknown share slug matches nothing rather than everything', async () => {
		const html = await search('?share=helicopter');
		expect(html).toContain('No posts found');
	});
});

describe('the write replaces the set', () => {
	it('drops a type the edit form no longer submits', async () => {
		const postId = await seedPost({ userId, conferenceId, title: 'Shrinking', description: 'x' });
		await setShareTypesForPost(testEnv, postId, ['lodging', 'carpool']);

		await handleEditPostSubmit(
			testRequest(`/post/${postId}/edit`, {
				cookie: await sessionCookie(userId),
				form: { position_slug: 'professor', institution: 'State University', title: 'Shrinking', description: 'x', share_types: ['lodging'] },
			}),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(await slugsFor(postId)).toEqual(['lodging']);
	});

	it('clears every type when the form submits none', async () => {
		// The case an add-only write gets wrong: unchecking every box submits no
		// share_types key at all, which is indistinguishable from "leave alone"
		// unless the delete runs unconditionally.
		const postId = await seedPost({ userId, conferenceId, title: 'Emptying', description: 'x' });
		await setShareTypesForPost(testEnv, postId, ['lodging', 'carpool']);

		await handleEditPostSubmit(
			testRequest(`/post/${postId}/edit`, {
				cookie: await sessionCookie(userId),
				form: { position_slug: 'professor', institution: 'State University', title: 'Emptying', description: 'x' },
			}),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(await slugsFor(postId)).toEqual([]);
	});

	it('ignores a slug outside the curated list', async () => {
		const postId = await seedPost({ userId, conferenceId, title: 'Hand-edited', description: 'x' });
		await setShareTypesForPost(testEnv, postId, ['lodging', 'private-jet']);

		expect(await slugsFor(postId)).toEqual(['lodging']);
	});

	it('is idempotent when the same slug arrives twice', async () => {
		const postId = await seedPost({ userId, conferenceId, title: 'Duplicated', description: 'x' });
		await setShareTypesForPost(testEnv, postId, ['lodging', 'lodging']);

		expect(await slugsFor(postId)).toEqual(['lodging']);
	});
});

describe('the edit form reflects what the post already offers', () => {
	it('pre-checks the current types and leaves the rest unchecked', async () => {
		const postId = await seedPost({ userId, conferenceId, title: 'Editable', description: 'x' });
		await setShareTypesForPost(testEnv, postId, ['carpool']);

		const response = await handleEditPostForm(
			testRequest(`/post/${postId}/edit`, { cookie: await sessionCookie(userId) }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);
		const html = await response.text();

		expect(html).toContain('value="carpool" checked');
		expect(html).toContain('value="lodging"');
		expect(html).not.toContain('value="lodging" checked');
	});

	it('offers the picker on a post that has never had one', async () => {
		// Every post written before this feature is in this state; the point of
		// putting the picker on the edit form is that they are not stranded the
		// way untagged conferences are.
		const postId = await seedPost({ userId, conferenceId, title: 'Legacy', description: 'x' });

		const response = await handleEditPostForm(
			testRequest(`/post/${postId}/edit`, { cookie: await sessionCookie(userId) }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(await response.text()).toContain('value="lodging"');
	});
});

describe('badges are read for a whole page in one query', () => {
	it('groups by post and omits posts with none', async () => {
		const a = await seedPost({ userId, conferenceId, title: 'A', description: 'x' });
		const b = await seedPost({ userId, conferenceId, title: 'B', description: 'x' });
		const none = await seedPost({ userId, conferenceId, title: 'C', description: 'x' });
		await setShareTypesForPost(testEnv, a, ['lodging', 'carpool']);
		await setShareTypesForPost(testEnv, b, ['rental-car']);

		const grouped = await listShareTypesForPosts(testEnv, [a, b, none]);

		expect(grouped.get(a)?.map((t) => t.slug)).toEqual(['lodging', 'carpool']);
		expect(grouped.get(b)?.map((t) => t.slug)).toEqual(['rental-car']);
		expect(grouped.has(none)).toBe(false);
	});

	it('returns an empty map for no posts rather than querying', async () => {
		expect((await listShareTypesForPosts(testEnv, [])).size).toBe(0);
	});
});
