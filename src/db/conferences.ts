/**
 * Every query against `conferences`, plus the slug rules that guard the table's
 * one unique constraint.
 *
 * KNOWN LIMITATION — creating a post against a new conference is not atomic.
 * It is three separate writes: `createConference()`, then `tagConference()`,
 * then `createPost()`. If the post insert fails, the conference survives as an
 * orphan and keeps its slug, so the user's retry gets `-2` appended to it.
 * D1's `batch()` cannot fix this, because the post insert needs the conference
 * id that the first statement RETURNs and `batch()` has no way to feed one
 * statement's output into the next. A real fix needs either a different API
 * shape or a periodic sweep of conferences with no posts. Recorded here rather
 * than papered over; see the backlog in CLAUDE.md.
 */

import type {
	Conference,
	ConferenceListing,
	ConferenceSummary,
	ConferenceWithPostCount,
	NewConference,
} from './types';

/** Every conference's page lives at /conference/:slug. */
export async function getConferenceBySlug(env: Env, slug: string): Promise<Conference | null> {
	return await env.DB.prepare(
		`
		SELECT id, name, slug, location_address, start_time, stop_time, description
		FROM conferences
		WHERE slug = ?
	`,
	)
		.bind(slug)
		.first<Conference>();
}

/**
 * Names and ids only — the create-post `<option>` list.
 *
 * Returns `ConferenceSummary`, not `Conference`. This is the query that used to
 * be typed as returning full conferences while selecting two columns, with an
 * `as unknown as` making the difference invisible.
 */
export async function listConferences(env: Env): Promise<ConferenceSummary[]> {
	const { results } = await env.DB.prepare(
		`
		SELECT id, name
		FROM conferences
		ORDER BY name ASC
	`,
	).all<ConferenceSummary>();
	return results ?? [];
}

/** The homepage's featured list. */
export async function listFeaturedConferences(env: Env): Promise<ConferenceListing[]> {
	const { results } = await env.DB.prepare(
		`
		SELECT id, name, slug, location_address, start_time, stop_time
		FROM conferences
		WHERE is_featured = 1
		ORDER BY created_at DESC
		LIMIT 10
	`,
	).all<ConferenceListing>();
	return results ?? [];
}

/**
 * Every conference, each with how many posts it has — the `/conferences` index.
 *
 * Deliberately unfiltered and unlimited: this is the page whose whole job is to
 * be the complete list, so a `LIMIT` here would make it quietly lie. The table
 * is small enough that this is one cheap scan; if it ever is not, the fix is
 * pagination in the handler, not a silent cap in the query.
 *
 * `start_time ASC` matches `listConferencesForTag()`, so a conference sits in
 * the same position on `/conferences` as it does on `/subject/:slug`. Note that
 * this puts finished conferences at the top — see the note on `handleAllConferences`.
 *
 * The subjects are NOT joined in here. Adding `conference_tags` to this query
 * would fan the rows out one per (conference, subject) pair and multiply
 * `COUNT(posts.id)` by the number of subjects; the grouping is done from
 * `listTagsForConferences()` instead, which is one further query rather than one
 * per row.
 */
export async function listAllConferences(env: Env): Promise<ConferenceWithPostCount[]> {
	const { results } = await env.DB.prepare(
		`
		SELECT conferences.id, conferences.name, conferences.slug,
		       conferences.location_address, conferences.start_time, conferences.stop_time,
		       COUNT(posts.id) AS post_count
		FROM conferences
		LEFT JOIN posts ON posts.conference_id = conferences.id
		GROUP BY conferences.id
		ORDER BY conferences.start_time ASC, conferences.name ASC
	`,
	).all<ConferenceWithPostCount>();
	return results ?? [];
}

/** Inserts a conference and returns its new id. */
export async function createConference(env: Env, input: NewConference): Promise<number> {
	const result = await env.DB.prepare(
		`
		INSERT INTO conferences (user_id, name, slug, location_address, start_time, stop_time, created_at, is_featured)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0)
		RETURNING id
	`,
	)
		.bind(input.userId, input.name, input.slug, input.locationAddress, input.startTime, input.stopTime, input.createdAt)
		.first<{ id: number }>();

	if (!result) throw new Error('Failed to create conference');
	return result.id;
}

function generateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)+/g, '');
}

/**
 * Turns a conference name into a slug nothing else is using yet.
 *
 * Slugs address /conference/:slug, so a collision would make the newer
 * conference unreachable; duplicates get `-2`, `-3`, … until one is free. A
 * UNIQUE index on `conferences.slug` is the backstop if two creates race
 * between this check and the insert.
 *
 * "Reserve" overstates it — nothing is held, so the name is a promise about
 * intent rather than about locking.
 */
export async function reserveSlug(env: Env, name: string): Promise<string> {
	const base = generateSlug(name) || 'conference';
	let slug = base;
	let suffix = 2;

	while (await env.DB.prepare(`SELECT 1 FROM conferences WHERE slug = ?`).bind(slug).first()) {
		slug = `${base}-${suffix}`;
		suffix += 1;
		if (suffix > 100) {
			slug = `${base}-${Date.now()}`;
			break;
		}
	}

	return slug;
}
