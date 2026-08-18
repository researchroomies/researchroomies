import { describe, it, expect, beforeEach } from 'vitest';
import { createExecutionContext, fetchMock } from 'cloudflare:test';
import { handleEditPostForm, handleEditPostSubmit } from '../src/routes/posts';
import { handleCreatePost } from '../src/routes/create-post';
import { handlePostPage } from '../src/routes/post-detail';
import { handleMyPosts } from '../src/routes/my-posts';
import { handleSearch } from '../src/routes/search';
import { listPositions, resolvePosition } from '../src/db/positions';
import { getPost, getPostWithConference } from '../src/db/posts';
import { getConferenceBySlug } from '../src/db/conferences';
import {
	expectTurnstile,
	resetDatabase,
	seedConference,
	seedPost,
	seedUser,
	sessionCookie,
	testEnv,
	testRequest,
} from './helpers/seed';

/**
 * Position and institution: who is posting, stated as data.
 *
 * Two things here are worth more than the happy path.
 *
 * The first is that both fields are **required**, which makes them the first
 * thing on this site that a bad submission must be *rejected* for rather than
 * quietly cleaned up. Share types drop an unknown slug and carry on, because a
 * post with fewer share types is a post the author could have written; a post
 * with no position is one the form says cannot exist. Several tests below check
 * that a rejection writes nothing at all — including no conference, since the
 * create handler may write one before it reaches the post.
 *
 * The second is that the columns are **nullable and cannot be backfilled**.
 * Every post on production predates them, so "not stated" is permanent, and a
 * renderer or a query that assumes otherwise fails only against real data. That
 * is why `seedPost()` leaves them null by default and why the LEFT JOIN has a
 * test of its own: an inner join would pass every other test in this file and
 * make every pre-existing post vanish from every listing.
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
		start: '2026-03-01',
		stop: '2026-03-05',
	});
});

/** A complete create-post body, minus whatever the caller overrides or drops. */
function createForm(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		conference_id: String(conferenceId),
		title: 'Roommate wanted',
		description: 'Sharing a queen room near the venue',
		position_slug: 'graduate',
		institution: 'University of Michigan',
		'cf-turnstile-response': 'token',
		...overrides,
	};
}

async function create(form: Record<string, string>): Promise<Response> {
	return await handleCreatePost(testRequest('/api/post', { cookie: await sessionCookie(userId), form }), testEnv, ctx());
}

async function countPosts(): Promise<number> {
	const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>();
	return row?.n ?? 0;
}

describe('0004 seeds the curated list', () => {
	it('leaves the six positions in career order, Other last', async () => {
		const positions = await listPositions(testEnv);

		expect(positions.map((position) => position.slug)).toEqual([
			'undergraduate',
			'graduate',
			'postdoc',
			'lecturer',
			'professor',
			'other',
		]);
		// The reason the table has sort_order at all: alphabetical would open on
		// 'Graduate Student' and bury 'Other Position' in the middle.
		expect(positions.at(-1)?.name).toBe('Other Position');
		expect(positions[0].name).toBe('Undergraduate Student');
	});
});

describe('resolvePosition validates rather than drops', () => {
	it('accepts a curated slug and carries no free text with it', async () => {
		expect(await resolvePosition(testEnv, 'postdoc', null)).toEqual({ slug: 'postdoc', other: null });
	});

	it('clears free text left behind by a change of mind', async () => {
		// The box stays filled in the DOM while it is hidden, so a user who types
		// "Staff scientist", reconsiders and picks Professor submits both. Storing
		// the leftover would produce a row claiming to be a Professor with an
		// 'other' label attached to it.
		expect(await resolvePosition(testEnv, 'professor', 'Staff scientist')).toEqual({
			slug: 'professor',
			other: null,
		});
	});

	it('keeps the free text for other, trimmed', async () => {
		expect(await resolvePosition(testEnv, 'other', '  Research scientist  ')).toEqual({
			slug: 'other',
			other: 'Research scientist',
		});
	});

	it('rejects other with an empty box, the same as no answer', async () => {
		expect(await resolvePosition(testEnv, 'other', '   ')).toBeNull();
		expect(await resolvePosition(testEnv, 'other', null)).toBeNull();
	});

	it('rejects a slug outside the curated list', async () => {
		// The contrast with setShareTypesForPost(), which drops one silently.
		expect(await resolvePosition(testEnv, 'dean', null)).toBeNull();
	});

	it('rejects a missing slug', async () => {
		expect(await resolvePosition(testEnv, null, null)).toBeNull();
		expect(await resolvePosition(testEnv, '', null)).toBeNull();
	});
});

describe('creating a post records who wrote it', () => {
	it('stores the position and the institution', async () => {
		expectTurnstile(true);
		const response = await create(createForm());

		expect(response.status).toBe(303);
		const row = await testEnv.DB.prepare('SELECT * FROM posts').first<{
			position_slug: string | null;
			position_other: string | null;
			institution: string | null;
		}>();
		expect(row).toMatchObject({
			position_slug: 'graduate',
			position_other: null,
			institution: 'University of Michigan',
		});
	});

	it('stores the free text behind Other Position', async () => {
		expectTurnstile(true);
		await create(createForm({ position_slug: 'other', position_other: 'Museum curator' }));

		const row = await testEnv.DB.prepare('SELECT * FROM posts').first<{
			position_slug: string | null;
			position_other: string | null;
		}>();
		expect(row).toMatchObject({ position_slug: 'other', position_other: 'Museum curator' });
	});

	it('refuses a post with no position and writes nothing', async () => {
		expectTurnstile(true);
		const form = createForm();
		delete form.position_slug;

		const response = await create(form);

		expect(response.status).toBe(400);
		expect(await countPosts()).toBe(0);
	});

	it('refuses a post with no institution and writes nothing', async () => {
		expectTurnstile(true);
		const response = await create(createForm({ institution: '   ' }));

		expect(response.status).toBe(400);
		expect(await countPosts()).toBe(0);
	});

	it('refuses Other Position with nothing typed into it', async () => {
		expectTurnstile(true);
		const response = await create(createForm({ position_slug: 'other', position_other: '' }));

		expect(response.status).toBe(400);
		expect(await countPosts()).toBe(0);
	});

	it('refuses a hand-edited slug rather than storing it', async () => {
		expectTurnstile(true);
		const response = await create(createForm({ position_slug: 'dean' }));

		expect(response.status).toBe(400);
		expect(await countPosts()).toBe(0);
	});

	it('does not leave an orphan conference behind when the position is bad', async () => {
		// The ordering test. Creating a post against a *new* conference is three
		// unprotected writes, so the author fields are validated before the first
		// of them. Moving that check after the conference branch leaves a
		// conference with no posts that has already taken its slug — so the
		// author's corrected retry comes back as "…-2".
		expectTurnstile(true);
		const response = await create(
			createForm({
				conference_id: 'new',
				new_conf_name: 'Marine Biology Congress',
				new_conf_start: '2026-06-10',
				new_conf_end: '2026-06-15',
				position_slug: 'dean',
			}),
		);

		expect(response.status).toBe(400);
		expect(await getConferenceBySlug(testEnv, 'marine-biology-congress')).toBeNull();
		expect(await countPosts()).toBe(0);
	});

	it('does not reach the database at all for an unverified request', async () => {
		// Turnstile runs first; the author check reads `positions`, and a bot
		// should not get that far. No interceptor is registered for a token that
		// was never sent, so a handler that verified one would fail here.
		const form = createForm();
		delete form['cf-turnstile-response'];

		const response = await create(form);

		expect(response.status).toBe(400);
		expect(await countPosts()).toBe(0);
	});
});

describe('the edit form is where a post written before the fields gets completed', () => {
	it('pre-selects the position the post already carries', async () => {
		const postId = await seedPost({
			userId,
			conferenceId,
			title: 'Original',
			description: 'x',
			position: { slug: 'postdoc', other: null },
			institution: 'Caltech',
		});

		const response = await handleEditPostForm(
			testRequest(`/post/${postId}/edit`, { cookie: await sessionCookie(userId) }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);
		const html = await response.text();

		expect(html).toContain('<option value="postdoc" selected>Postdoc</option>');
		expect(html).toContain('value="Caltech"');
		// Not 'other', so its box starts hidden and unrequired.
		expect(html).toContain('id="position-other-field" hidden');
	});

	it('opens the free-text box for a post that uses Other Position', async () => {
		const postId = await seedPost({
			userId,
			conferenceId,
			title: 'Original',
			description: 'x',
			position: { slug: 'other', other: 'Museum curator' },
			institution: 'The Field Museum',
		});

		const response = await handleEditPostForm(
			testRequest(`/post/${postId}/edit`, { cookie: await sessionCookie(userId) }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);
		const html = await response.text();

		expect(html).toContain('value="Museum curator"');
		expect(html).not.toContain('id="position-other-field" hidden');
	});

	it('renders the fields empty for a post that predates them', async () => {
		// The population the subject-tag bug left permanently untaggable. Every
		// post can be completed from here, whenever it was written.
		const postId = await seedPost({ userId, conferenceId, title: 'Old post', description: 'x' });

		const response = await handleEditPostForm(
			testRequest(`/post/${postId}/edit`, { cookie: await sessionCookie(userId) }),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('name="position_slug"');
		expect(html).not.toContain('selected>');
	});

	it('saves a position onto a post that had none', async () => {
		const postId = await seedPost({ userId, conferenceId, title: 'Old post', description: 'x' });

		const response = await handleEditPostSubmit(
			testRequest(`/post/${postId}/edit`, {
				cookie: await sessionCookie(userId),
				form: {
					title: 'Old post',
					description: 'x',
					position_slug: 'lecturer',
					institution: 'Reed College',
				},
			}),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(response.status).toBe(303);
		expect(await getPost(testEnv, postId)).toMatchObject({
			position_name: 'Lecturer',
			institution: 'Reed College',
		});
	});

	it('refuses to save an edit that drops the institution, leaving the post as it was', async () => {
		const postId = await seedPost({
			userId,
			conferenceId,
			title: 'Original',
			description: 'x',
			position: { slug: 'professor', other: null },
			institution: 'Caltech',
		});

		const response = await handleEditPostSubmit(
			testRequest(`/post/${postId}/edit`, {
				cookie: await sessionCookie(userId),
				form: { title: 'Changed', description: 'y', position_slug: 'professor', institution: '' },
			}),
			testEnv,
			ctx(),
			{ id: String(postId) },
		);

		expect(response.status).toBe(400);
		expect(await getPost(testEnv, postId)).toMatchObject({
			title: 'Original',
			institution: 'Caltech',
		});
	});
});

describe('reading a post back', () => {
	it('resolves the slug to its display name through the join', async () => {
		const postId = await seedPost({
			userId,
			conferenceId,
			title: 'Room share',
			description: 'x',
			position: { slug: 'graduate', other: null },
			institution: 'MIT',
		});

		expect(await getPostWithConference(testEnv, postId)).toMatchObject({
			position_slug: 'graduate',
			position_name: 'Graduate Student',
			institution: 'MIT',
		});
	});

	it('still returns a post that has no position', async () => {
		// The LEFT JOIN. An inner one passes every other test in this file and
		// makes every post written before this feature disappear from every page.
		const postId = await seedPost({ userId, conferenceId, title: 'Old post', description: 'x' });

		expect(await getPostWithConference(testEnv, postId)).toMatchObject({
			position_slug: null,
			position_name: null,
			institution: null,
		});
	});
});

describe('the byline on the pages that show a post', () => {
	async function postPage(postId: number): Promise<string> {
		const response = await handlePostPage(testRequest(`/post/${postId}`), testEnv, ctx(), { id: String(postId) });
		return await response.text();
	}

	it('states the position and the institution as facts', async () => {
		const postId = await seedPost({
			userId,
			conferenceId,
			title: 'Room share',
			description: 'x',
			position: { slug: 'graduate', other: null },
			institution: 'MIT',
		});

		const html = await postPage(postId);

		expect(html).toContain('<dt>Position</dt><dd>Graduate Student</dd>');
		expect(html).toContain('<dt>Institution</dt><dd>MIT</dd>');
	});

	it('shows what the author typed, not the word "Other Position"', async () => {
		const postId = await seedPost({
			userId,
			conferenceId,
			title: 'Room share',
			description: 'x',
			position: { slug: 'other', other: 'Museum curator' },
			institution: 'The Field Museum',
		});

		const html = await postPage(postId);

		expect(html).toContain('<dd>Museum curator</dd>');
		expect(html).not.toContain('Other Position');
	});

	it('omits both rows on a post that states neither', async () => {
		const postId = await seedPost({ userId, conferenceId, title: 'Old post', description: 'x' });

		const html = await postPage(postId);

		expect(html).not.toContain('<dt>Position</dt>');
		expect(html).not.toContain('<dt>Institution</dt>');
		// And the rest of the page is unaffected.
		expect(html).toContain('Old post');
		expect(html).toContain('<dt>Dates</dt>');
	});

	it('escapes an institution somebody has put markup into', async () => {
		const postId = await seedPost({
			userId,
			conferenceId,
			title: 'Room share',
			description: 'x',
			position: { slug: 'professor', other: null },
			institution: '<script>alert(1)</script>',
		});

		const html = await postPage(postId);

		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('appears on the search results and on /my-posts', async () => {
		await seedPost({
			userId,
			conferenceId,
			title: 'Room share',
			description: 'x',
			position: { slug: 'graduate', other: null },
			institution: 'MIT',
		});

		const search = await (await handleSearch(testRequest('/search'), testEnv, ctx())).text();
		const mine = await (
			await handleMyPosts(testRequest('/my-posts', { cookie: await sessionCookie(userId) }), testEnv, ctx())
		).text();

		expect(search).toContain('Graduate Student &middot; MIT');
		expect(mine).toContain('Graduate Student &middot; MIT');
	});

	it('leaves a listing row unchanged when a post states neither', async () => {
		await seedPost({ userId, conferenceId, title: 'Old post', description: 'x' });

		const search = await (await handleSearch(testRequest('/search'), testEnv, ctx())).text();

		expect(search).toContain('Old post');
		expect(search).not.toContain('post-author');
	});
});
