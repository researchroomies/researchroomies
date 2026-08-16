/**
 * Every query against `share_types` and `post_share_types`.
 *
 * Share types are post-level and the list is curated, so this file is a close
 * sibling of tags.ts. The one deliberate difference is the write:
 * `tagConference()` only ever adds, because subjects are set once when a
 * conference is created and there is no UI to change them afterwards — which is
 * exactly why production has conferences that can never be tagged. Share types
 * are set on create *and* on edit, so the write here replaces the whole set;
 * otherwise unchecking a box would silently do nothing.
 */

import type { PostShareType, ShareType } from './types';

/**
 * The curated list, in display order.
 *
 * `sort_order` rather than `name`: the picker reads top to bottom and 'Other'
 * belongs at the bottom, which alphabetical puts in the middle.
 */
export async function listShareTypes(env: Env): Promise<ShareType[]> {
	const { results } = await env.DB.prepare(`SELECT slug, name FROM share_types ORDER BY sort_order ASC, name ASC`).all<ShareType>();
	return results ?? [];
}

/**
 * What a single post offers, in display order — the post page and the edit form.
 *
 * There is deliberately no `getShareType(slug)` beside this. `/search?share=` does
 * not validate its slug against the list: an unknown one simply matches no rows,
 * which is the same answer `?tag=` gives and is indistinguishable to the caller
 * from a real filter with no results.
 */
export async function listShareTypesForPost(env: Env, postId: number): Promise<ShareType[]> {
	const { results } = await env.DB.prepare(
		`
		SELECT share_types.slug, share_types.name
		FROM post_share_types
		JOIN share_types ON post_share_types.share_slug = share_types.slug
		WHERE post_share_types.post_id = ?
		ORDER BY share_types.sort_order ASC
	`,
	)
		.bind(postId)
		.all<ShareType>();
	return results ?? [];
}

/**
 * What each of several posts offers, in one query.
 *
 * The listing pages (`/search`, `/my-posts`, a conference's post list) render a
 * badge row per post. Calling `listShareTypesForPost()` in a loop would be a
 * query per row, so this reads them all at once and groups in memory. Posts with
 * no share types are simply absent from the map; callers should treat a missing
 * key as the empty list rather than as an error.
 */
export async function listShareTypesForPosts(env: Env, postIds: number[]): Promise<Map<number, ShareType[]>> {
	const grouped = new Map<number, ShareType[]>();
	if (postIds.length === 0) return grouped;

	// The ids come from rows this request already read, but they are still bound
	// rather than interpolated — the placeholder count is the only thing the
	// array length is allowed to decide.
	const placeholders = postIds.map(() => '?').join(', ');
	const { results } = await env.DB.prepare(
		`
		SELECT post_share_types.post_id, share_types.slug, share_types.name
		FROM post_share_types
		JOIN share_types ON post_share_types.share_slug = share_types.slug
		WHERE post_share_types.post_id IN (${placeholders})
		ORDER BY share_types.sort_order ASC
	`,
	)
		.bind(...postIds)
		.all<PostShareType>();

	for (const row of results ?? []) {
		const existing = grouped.get(row.post_id);
		if (existing) existing.push({ slug: row.slug, name: row.name });
		else grouped.set(row.post_id, [{ slug: row.slug, name: row.name }]);
	}
	return grouped;
}

/**
 * Replaces the share types on a post, dropping any slug not in the curated list.
 *
 * Replace rather than add, so that clearing every box on the edit form clears
 * the post — the delete runs even when `slugs` is empty, which is the case that
 * an add-only write gets wrong.
 *
 * The filter against `share_types` is what keeps the curated list curated: the
 * slugs arrive from a form body, and anything accepted here goes on to render as
 * a badge and to answer the `/search?share=` filter. Unknown slugs are dropped
 * silently — they can only come from a hand-edited form, and the list is not a
 * secret worth reporting on.
 *
 * The delete and the inserts go through `batch()`, which D1 runs in a single
 * transaction, so a post is never left with its old types removed and its new
 * ones unwritten.
 */
export async function setShareTypesForPost(env: Env, postId: number, slugs: string[]): Promise<void> {
	const valid = new Set((await listShareTypes(env)).map((type) => type.slug));
	const accepted = [...new Set(slugs.filter((slug) => valid.has(slug)))];

	await env.DB.batch([
		env.DB.prepare(`DELETE FROM post_share_types WHERE post_id = ?`).bind(postId),
		...accepted.map((slug) =>
			env.DB.prepare(`INSERT INTO post_share_types (share_slug, post_id) VALUES (?, ?)`).bind(slug, postId),
		),
	]);
}
