/**
 * Every query against `tags` and `conference_tags`.
 *
 * Tags are conference-level and the list is curated: `tags` is seeded from
 * `db/schema.sql` and nothing in the application inserts into it. `tagConference()`
 * is what keeps that true — see its doc comment.
 */

import type { ConferenceWithPostCount, Tag } from './types';

/** The curated subject list, alphabetical — the nav and every subject picker. */
export async function listTags(env: Env): Promise<Tag[]> {
	const { results } = await env.DB.prepare(`SELECT slug, name FROM tags ORDER BY name ASC`).all<Tag>();
	return results ?? [];
}

/** One subject by slug; null is how /subject/:slug learns the slug is not real. */
export async function getTag(env: Env, slug: string): Promise<Tag | null> {
	return await env.DB.prepare(`SELECT slug, name FROM tags WHERE slug = ?`).bind(slug).first<Tag>();
}

/** The subjects a conference is tagged with. */
export async function listTagsForConference(env: Env, conferenceId: number): Promise<Tag[]> {
	const { results } = await env.DB.prepare(
		`
		SELECT tags.slug, tags.name
		FROM conference_tags
		JOIN tags ON conference_tags.tag_slug = tags.slug
		WHERE conference_tags.conference_id = ?
		ORDER BY tags.name ASC
	`,
	)
		.bind(conferenceId)
		.all<Tag>();
	return results ?? [];
}

/**
 * Tags a conference, ignoring any slug that is not in the curated list.
 *
 * That filter is the reason the curated list stays curated, and it belongs with
 * the write rather than in the HTTP handler that used to hold it: the slugs
 * arrive from a form, so anything accepted here goes straight into
 * `conference_tags` and then into the nav and the /subject/:slug pages, which
 * read from `tags`. Unknown slugs are dropped silently — they can only come from
 * a hand-edited form, and the curated list is not a secret worth reporting on.
 *
 * `INSERT OR IGNORE` makes re-tagging idempotent against the composite primary
 * key. A caller passing no valid slugs performs no writes at all.
 */
export async function tagConference(env: Env, conferenceId: number, slugs: string[]): Promise<void> {
	if (slugs.length === 0) return;

	const valid = new Set((await listTags(env)).map((tag) => tag.slug));
	const inserts = slugs
		.filter((slug) => valid.has(slug))
		.map((slug) =>
			env.DB.prepare(`INSERT OR IGNORE INTO conference_tags (tag_slug, conference_id) VALUES (?, ?)`).bind(
				slug,
				conferenceId,
			),
		);

	if (inserts.length > 0) await env.DB.batch(inserts);
}

/** The conferences tagged with one subject, each with how many posts it has. */
export async function listConferencesForTag(env: Env, slug: string): Promise<ConferenceWithPostCount[]> {
	const { results } = await env.DB.prepare(
		`
		SELECT conferences.id, conferences.name, conferences.slug,
		       conferences.location_address, conferences.start_time, conferences.stop_time,
		       COUNT(posts.id) AS post_count
		FROM conferences
		JOIN conference_tags ON conference_tags.conference_id = conferences.id
		LEFT JOIN posts ON posts.conference_id = conferences.id
		WHERE conference_tags.tag_slug = ?
		GROUP BY conferences.id
		ORDER BY conferences.start_time ASC
	`,
	)
		.bind(slug)
		.all<ConferenceWithPostCount>();
	return results ?? [];
}
