import { describe, it, expect, beforeEach } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import { handleAllConferences } from '../src/routes/conferences';
import { tagConference } from '../src/db/tags';
import { listAllConferences } from '../src/db/conferences';
import { resetDatabase, seedConference, seedPost, seedUser, testEnv, testRequest } from './helpers/seed';

/**
 * `/conferences` — every conference, grouped by subject.
 *
 * The behaviour worth pinning is the grouping, not the markup: subjects are a
 * many-to-many, so the three questions this page had to answer are what happens
 * to a conference with two subjects, what happens to one with none, and what
 * happens to a subject with no conferences. Each has a test below, because each
 * had a defensible alternative answer.
 *
 * The post-count test is the one guarding an actual trap: joining
 * `conference_tags` into the counting query would multiply `COUNT(posts.id)` by
 * the number of subjects, and the wrong number is a plausible-looking one.
 */

const ctx = () => createExecutionContext();

beforeEach(async () => {
	await resetDatabase();
});

interface RenderedGroup {
	heading: string;
	slugs: string[];
}

/** The rendered page as its group structure: heading text, then the conference slugs under it. */
function parseGroups(html: string): RenderedGroup[] {
	return html
		.split('<section class="subject-group">')
		.slice(1)
		.map((section) => ({
			// The heading is a link for a real subject and bare text for the untagged group.
			heading: (section.match(/<h3>(?:\s*<a[^>]*>)?([^<]+)/)?.[1] ?? '').trim(),
			slugs: [...section.matchAll(/href="\/conference\/([^"]+)"/g)].map((match) => match[1]),
		}));
}

/** The "N posts" text rendered for one conference. */
function postCountFor(html: string, slug: string): string {
	const item = html.split(`href="/conference/${slug}"`)[1] ?? '';
	return (item.match(/·\s*(\d+ posts?)/)?.[1] ?? '').trim();
}

async function page(): Promise<{ status: number; html: string; response: Response }> {
	const response = await handleAllConferences(testRequest('/conferences'), testEnv, ctx());
	return { status: response.status, html: await response.text(), response };
}

async function conference(
	name: string,
	slug: string,
	subjects: string[] = [],
	start = '2026-06-01',
): Promise<number> {
	const userId = await seedUser(`${slug}@university.edu`);
	const id = await seedConference({
		userId,
		name,
		slug,
		locationAddress: 'Boston, MA',
		start,
		stop: start,
	});
	if (subjects.length > 0) await tagConference(testEnv, id, subjects);
	return id;
}

describe('grouping', () => {
	it('puts each conference under the subject it carries', async () => {
		await conference('Bio Congress', 'bio-congress', ['biology']);
		await conference('Chem Summit', 'chem-summit', ['chemistry']);

		const groups = parseGroups((await page()).html);

		expect(groups).toEqual([
			{ heading: 'Biology', slugs: ['bio-congress'] },
			{ heading: 'Chemistry', slugs: ['chem-summit'] },
		]);
	});

	it('lists a conference under every subject it carries, not just one', async () => {
		// The case the many-to-many exists for. Picking a single "primary"
		// subject would hide this conference from one of its two audiences.
		await conference('Computational Biology', 'comp-bio', ['biology', 'computer-science']);

		const groups = parseGroups((await page()).html);

		expect(groups.map((group) => group.heading)).toEqual(['Biology', 'Computer Science']);
		expect(groups.every((group) => group.slugs.includes('comp-bio'))).toBe(true);
	});

	it('collects untagged conferences into a trailing group rather than dropping them', async () => {
		// Not hypothetical: on production almost every conference is untagged,
		// because subjects can only be set while creating one. Dropping them
		// would render an empty page against the live database.
		await conference('Physics Meeting', 'physics-meeting', ['physics']);
		await conference('Untagged Workshop', 'untagged-workshop');

		const groups = parseGroups((await page()).html);

		expect(groups.map((group) => group.heading)).toEqual(['Physics', 'No subject yet']);
		expect(groups[1].slugs).toEqual(['untagged-workshop']);
	});

	it('renders only the untagged group when nothing is tagged', async () => {
		await conference('One', 'one');
		await conference('Two', 'two');

		const groups = parseGroups((await page()).html);

		expect(groups).toHaveLength(1);
		expect(groups[0].heading).toBe('No subject yet');
		expect(groups[0].slugs).toEqual(['one', 'two']);
	});

	it('omits subjects that have no conferences', async () => {
		await conference('Bio Congress', 'bio-congress', ['biology']);

		const { html } = await page();

		// The curated list has twelve subjects; eleven of them are empty here and
		// none should appear as a heading.
		expect(parseGroups(html)).toHaveLength(1);
		expect(html).not.toContain('Humanities');
		expect(html).not.toContain('Economics');
	});

	it('orders groups by subject name regardless of insertion order', async () => {
		// The start dates make the conferences arrive in reverse subject order, so
		// the groups are built Physics → Mathematics → Biology. Without the sort
		// the page would render them that way, which is why the dates are set
		// rather than left at the shared default: with equal dates the query falls
		// back to conference name, and an alphabetical-by-name seed makes this
		// test pass whether or not anything sorts.
		await conference('Physics Meeting', 'physics-meeting', ['physics'], '2026-02-01');
		await conference('Math Colloquium', 'math-colloquium', ['mathematics'], '2026-03-01');
		await conference('Bio Congress', 'bio-congress', ['biology'], '2026-04-01');

		const groups = parseGroups((await page()).html);

		expect(groups.map((group) => group.heading)).toEqual(['Biology', 'Mathematics', 'Physics']);
	});

	it('orders conferences within a group by start date', async () => {
		const userId = await seedUser('prof@university.edu');
		const later = await seedConference({
			userId,
			name: 'Later',
			slug: 'later',
			start: '2026-09-01',
			stop: '2026-09-03',
		});
		const earlier = await seedConference({
			userId,
			name: 'Earlier',
			slug: 'earlier',
			start: '2026-02-01',
			stop: '2026-02-03',
		});
		await tagConference(testEnv, later, ['physics']);
		await tagConference(testEnv, earlier, ['physics']);

		const groups = parseGroups((await page()).html);

		expect(groups[0].slugs).toEqual(['earlier', 'later']);
	});
});

describe('post counts', () => {
	it('counts a conference once per post, not once per post per subject', async () => {
		// The fan-out this page's query is shaped to avoid: joining
		// conference_tags into the counting query multiplies COUNT(posts.id) by
		// the number of subjects, and "6 posts" looks entirely plausible.
		const userId = await seedUser('prof@university.edu');
		const conferenceId = await seedConference({
			userId,
			name: 'Computational Biology',
			slug: 'comp-bio',
			start: '2026-06-01',
			stop: '2026-06-04',
		});
		await tagConference(testEnv, conferenceId, ['biology', 'computer-science', 'mathematics']);
		for (const title of ['Room to share', 'Carpool from BOS', 'Rental car']) {
			await seedPost({ userId, conferenceId, title, description: 'Details.' });
		}

		const { html } = await page();

		expect(postCountFor(html, 'comp-bio')).toBe('3 posts');
		// Same number wherever it is listed.
		expect([...html.matchAll(/·\s*3 posts/g)]).toHaveLength(3);
	});

	it('shows zero for a conference with no posts, and singular for one', async () => {
		const userId = await seedUser('prof@university.edu');
		const empty = await seedConference({ userId, name: 'Empty', slug: 'empty', start: '2026-06-01', stop: '2026-06-02' });
		const single = await seedConference({ userId, name: 'Single', slug: 'single', start: '2026-07-01', stop: '2026-07-02' });
		await seedPost({ userId, conferenceId: single, title: 'Room to share', description: 'Details.' });
		await tagConference(testEnv, empty, ['physics']);
		await tagConference(testEnv, single, ['physics']);

		const { html } = await page();

		expect(postCountFor(html, 'empty')).toBe('0 posts');
		expect(postCountFor(html, 'single')).toBe('1 post');
	});
});

describe('the page itself', () => {
	it('is a complete cacheable HTML page', async () => {
		await conference('Bio Congress', 'bio-congress', ['biology']);

		const { status, html, response } = await page();

		expect(status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain('<title>All Conferences – ResearchRoomies</title>');
	});

	it('carries a description and a canonical URL', async () => {
		// The backlog item this page deliberately does not add to: several Worker
		// pages render no meta at all and produce no link preview.
		const { html } = await page();

		expect(html).toMatch(/<meta name="description" content="[^"]+"/);
		expect(html).toContain('https://researchroomies.com/conferences');
	});

	it('renders an empty state rather than failing on an empty database', async () => {
		const { status, html } = await page();

		expect(status).toBe(200);
		expect(html).toContain('No conferences have been added yet');
		expect(parseGroups(html)).toEqual([]);
	});

	it('links each conference to its own page and each subject to its subject page', async () => {
		await conference('Bio Congress', 'bio-congress', ['biology']);

		const { html } = await page();

		expect(html).toContain('href="/conference/bio-congress"');
		expect(html).toContain('href="/subject/biology"');
	});

	it('escapes conference names', async () => {
		await conference('<script>alert(1)</script>', 'xss-conference', ['physics']);

		const { html } = await page();

		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
	});
});

describe('listAllConferences', () => {
	it('returns every conference, including untagged and post-less ones', async () => {
		await conference('Tagged', 'tagged', ['physics']);
		await conference('Untagged', 'untagged');

		const results = await listAllConferences(testEnv);

		expect(results.map((row) => row.slug).sort()).toEqual(['tagged', 'untagged']);
		expect(results.every((row) => row.post_count === 0)).toBe(true);
	});
});
