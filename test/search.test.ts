import { describe, it, expect, beforeEach } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import { handleSearch } from '../src/routes/api';
import { SEARCH_LIMIT } from '../src/db/posts';
import { resetDatabase, seedConference, seedPost, seedUser, testEnv, testRequest, ts } from './helpers/seed';
import { tagConference } from '../src/db/tags';

/**
 * `/search` is where a silent behaviour change in this refactor was most likely
 * to hide. Its WHERE clause is assembled at runtime from five independent
 * filters, and the old builder pushed SQL fragments into one array and their
 * bindings into another — so a clause added without its binding, or two
 * bindings pushed in the wrong order, shifts every later `?` onto the wrong
 * value. That fails silently: the query still runs and still returns rows,
 * just the wrong ones.
 *
 * The filters below are chosen so that a swap is *visible*. Each one selects a
 * different subset, and the combination tests assert an intersection that only
 * the correct pairing can produce — see the comments on each.
 */

const ctx = () => createExecutionContext();

async function search(query: string): Promise<string> {
	const response = await handleSearch(testRequest(`/search${query}`), testEnv, ctx());
	expect(response.status).toBe(200);
	return await response.text();
}

/** Post titles are unique in the fixture, so presence in the HTML identifies a row. */
function found(html: string, ...titles: string[]): void {
	for (const title of TITLES) {
		const expected = titles.includes(title);
		expect(html.includes(title), `${expected ? 'expected' : 'did not expect'} "${title}"`).toBe(expected);
	}
}

const QCS_ROOMMATE = 'Roommate wanted for the quantum summit';
const QCS_CARPOOL = 'Carpool from Providence';
const MARINE_ROOMMATE = 'Roommate for the marine congress';
const ALGEBRA_RIDE = 'Ride share to the algebra workshop';
const TITLES = [QCS_ROOMMATE, QCS_CARPOOL, MARINE_ROOMMATE, ALGEBRA_RIDE];

beforeEach(async () => {
	await resetDatabase();
	const userId = await seedUser('prof@university.edu');

	// Three conferences with non-overlapping date ranges, so a date filter picks
	// a different subset from every other filter.
	const quantum = await seedConference({
		userId,
		name: 'Quantum Computing Summit',
		slug: 'quantum-computing-summit',
		locationAddress: 'Boston, MA',
		start: '2026-03-01',
		stop: '2026-03-05',
	});
	const marine = await seedConference({
		userId,
		name: 'Marine Biology Congress',
		slug: 'marine-biology-congress',
		locationAddress: 'San Diego, CA',
		start: '2026-06-10',
		stop: '2026-06-15',
	});
	const algebra = await seedConference({
		userId,
		name: 'Algebra Workshop',
		slug: 'algebra-workshop',
		locationAddress: 'Austin, TX',
		start: '2026-09-01',
		stop: '2026-09-03',
	});

	await tagConference(testEnv, quantum, ['computer-science']);
	await tagConference(testEnv, marine, ['biology']);
	// algebra is deliberately untagged.

	await seedPost({
		userId,
		conferenceId: quantum,
		title: QCS_ROOMMATE,
		description: 'Sharing a hotel room near the venue',
		createdAt: ts('2026-01-05'),
	});
	await seedPost({
		userId,
		conferenceId: quantum,
		title: QCS_CARPOOL,
		description: 'Driving up on the Monday morning',
		createdAt: ts('2026-01-06'),
	});
	await seedPost({
		userId,
		conferenceId: marine,
		title: MARINE_ROOMMATE,
		description: 'Two beds, split the cost',
		createdAt: ts('2026-01-07'),
	});
	await seedPost({
		userId,
		conferenceId: algebra,
		title: ALGEBRA_RIDE,
		description: 'Splitting gas, saving 50% each',
		createdAt: ts('2026-01-08'),
	});
});

describe('no filters', () => {
	it('returns every post', async () => {
		found(await search(''), ...TITLES);
	});

	it('orders by conference start date, then newest post first', async () => {
		const html = await search('');
		const order = TITLES.map((title) => ({ title, at: html.indexOf(title) })).sort((a, b) => a.at - b.at);
		expect(order.map((entry) => entry.title)).toEqual([
			// March conference, newer post first…
			QCS_CARPOOL,
			QCS_ROOMMATE,
			// …then June, then September.
			MARINE_ROOMMATE,
			ALGEBRA_RIDE,
		]);
	});

	it('says the site is empty rather than that the search failed', async () => {
		await resetDatabase();
		expect(await search('')).toContain('No posts yet');
	});
});

describe('q', () => {
	it('matches the post title', async () => {
		found(await search('?q=Carpool'), QCS_CARPOOL);
	});

	it('matches the post description', async () => {
		found(await search('?q=hotel'), QCS_ROOMMATE);
	});

	it('matches case-insensitively', async () => {
		found(await search('?q=ROOMMATE'), QCS_ROOMMATE, MARINE_ROOMMATE);
	});

	it('treats % as a literal rather than as a wildcard', async () => {
		// The whole point of escapeLike(). Unescaped, "%" is "match everything";
		// escaped, it matches the one description containing a per-cent sign.
		found(await search('?q=%25'), ALGEBRA_RIDE);
	});

	it('treats _ as a literal too', async () => {
		// "_" is LIKE's single-character wildcard, so unescaped "R_ommate" would
		// match "Roommate". Nothing in the fixture contains a real underscore.
		found(await search('?q=R_ommate'));
	});

	it('reports no matches distinctly from an empty site', async () => {
		const html = await search('?q=nothingmatchesthis');
		expect(html).toContain('No posts found matching your search');
		expect(html).not.toContain('No posts yet');
	});
});

describe('conference', () => {
	it('matches on a fragment of the conference name', async () => {
		found(await search('?conference=Marine'), MARINE_ROOMMATE);
	});
});

describe('tag', () => {
	it('matches an exact tag slug', async () => {
		found(await search('?tag=computer-science'), QCS_ROOMMATE, QCS_CARPOOL);
	});

	it('returns nothing for a tag no conference carries', async () => {
		found(await search('?tag=economics'));
	});
});

describe('date range', () => {
	it('start keeps conferences that have not already finished', async () => {
		found(await search('?start=2026-06-01'), MARINE_ROOMMATE, ALGEBRA_RIDE);
	});

	it('end keeps conferences that have already begun', async () => {
		found(await search('?end=2026-06-11'), QCS_ROOMMATE, QCS_CARPOOL, MARINE_ROOMMATE);
	});

	it('is inclusive at both bounds', async () => {
		// The marine congress runs 06-10 to 06-15; both of these touch an edge.
		found(await search('?start=2026-06-15&end=2026-06-10'), MARINE_ROOMMATE);
	});

	it('ignores an unparseable date instead of failing the search', async () => {
		found(await search('?start=not-a-date'), ...TITLES);
	});
});

describe('combinations', () => {
	/**
	 * These are the binding-order tests. Each asserts a result that is only
	 * reachable if every filter's bindings landed on that filter's `?`.
	 */

	it('q AND conference intersect', async () => {
		// "roommate" alone matches two posts and "Quantum" alone matches two;
		// together exactly one. Swap the two bindings and the conference name is
		// searched for "roommate" and the post text for "Quantum" — no rows.
		found(await search('?q=Roommate&conference=Quantum'), QCS_ROOMMATE);
	});

	it('q AND tag intersect', async () => {
		found(await search('?q=Roommate&tag=biology'), MARINE_ROOMMATE);
	});

	it('start AND end intersect', async () => {
		// Swapping these two timestamps asks for conferences that end after June
		// 11th and start before June 1st, which is nothing.
		found(await search('?start=2026-06-01&end=2026-06-11'), MARINE_ROOMMATE);
	});

	it('every filter at once', async () => {
		found(
			await search('?q=Roommate&conference=Quantum&tag=computer-science&start=2026-03-01&end=2026-03-05'),
			QCS_ROOMMATE,
		);
	});

	it('every filter at once, with one that excludes the rest', async () => {
		// Same as above but the date window has moved past the quantum summit.
		found(await search('?q=Roommate&conference=Quantum&tag=computer-science&start=2026-06-01&end=2026-06-11'));
	});
});

describe(`the ${SEARCH_LIMIT}-result cap`, () => {
	it('caps the rows and says so', async () => {
		const userId = await seedUser('prof@university.edu');
		const conferenceId = await seedConference({
			userId,
			name: 'Big Conference',
			slug: 'big-conference',
			start: '2026-04-01',
			stop: '2026-04-02',
		});
		for (let i = 0; i < SEARCH_LIMIT + 5; i += 1) {
			await seedPost({ userId, conferenceId, title: `Bulk post ${i}`, description: 'x' });
		}

		const html = await search('?conference=Big');
		expect(html).toContain(`${SEARCH_LIMIT} posts (showing the first ${SEARCH_LIMIT})`);
	});

	it('does not claim to be capped when it is not', async () => {
		const html = await search('');
		expect(html).toContain('4 posts');
		expect(html).not.toContain('showing the first');
	});

	it('says "1 post", not "1 posts"', async () => {
		expect(await search('?q=Carpool')).toContain('1 post<');
	});
});
