/**
 * Every query against `positions`.
 *
 * A close sibling of share-types.ts — a curated list read by slug, ordered by a
 * `sort_order` that alphabetical would ruin — with one deliberate difference
 * that runs all the way up through the handlers: **a position is required, so
 * an invalid one is rejected rather than dropped.**
 *
 * `setShareTypesForPost()` silently discards a slug outside its list, which is
 * right there because share types are optional: discarding one leaves the post
 * in a state the user could have chosen anyway. Position cannot be discarded
 * that way. Dropping it would write a post with no position through a form that
 * says the field is mandatory, so `resolvePosition()` returns null and the
 * handler answers 400.
 *
 * The post columns themselves live on `posts` and are written by
 * `createPost()` / `updatePost()`; there is no join table, because a post has
 * exactly one author with exactly one position.
 */

import type { Position, PositionInput } from './types';

/** The slug whose free-text companion is required. */
export const OTHER_POSITION = 'other';

/**
 * The curated list, in display order.
 *
 * `sort_order` rather than `name`, as in `listShareTypes()`: this list runs from
 * earliest career stage to latest and ends at 'Other Position'. Alphabetical
 * would open on 'Graduate Student' and put 'Other Position' in the middle.
 */
export async function listPositions(env: Env): Promise<Position[]> {
	const { results } = await env.DB.prepare(
		`SELECT slug, name FROM positions ORDER BY sort_order ASC, name ASC`,
	).all<Position>();
	return results ?? [];
}

/**
 * A submitted position, validated against the curated list, or null.
 *
 * Null means "do not write this" and every caller turns it into a 400. The three
 * ways to get it:
 *
 *   - a slug that is not in `positions`, which can only come from a hand-edited
 *     form (the picker renders the list) — and unlike an unknown share type it
 *     cannot be quietly dropped, because the field is required;
 *   - `other` with nothing in its free-text box, which is the same omission as
 *     leaving the dropdown unset and must read the same way;
 *   - no slug at all.
 *
 * When the slug is not `other`, the free text is cleared rather than carried.
 * The box stays filled in the DOM while it is hidden, so a user who types "Staff
 * scientist", changes their mind and picks Professor still submits both — and
 * storing the leftover would leave a row claiming to be a Professor with an
 * 'other' label attached to it.
 */
export async function resolvePosition(
	env: Env,
	slug: string | null,
	other: string | null,
): Promise<PositionInput | null> {
	const wanted = slug?.trim() ?? '';
	if (!wanted) return null;

	const valid = new Set((await listPositions(env)).map((position) => position.slug));
	if (!valid.has(wanted)) return null;

	if (wanted !== OTHER_POSITION) return { slug: wanted, other: null };

	const freeText = other?.trim() ?? '';
	return freeText ? { slug: wanted, other: freeText } : null;
}
