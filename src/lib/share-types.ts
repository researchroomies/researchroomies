/**
 * The two ways a share type is drawn: as a picker, and as a badge.
 *
 * This is in lib/ rather than in a route module because four callers need it and
 * none of them may import each other — the create-form fragment
 * (components.ts), the edit form (posts.ts), the post page (post-detail.ts) and
 * the result cards (search.ts, posts.ts). `turnstileWidget()` is the same shape
 * of thing for the same reason.
 */

import { escapeHtml } from './html';
import { listShareTypes, listShareTypesForPost } from '../db/share-types';
import type { ShareType } from '../db/types';

/**
 * The picker, ready to interpolate: curated list, current selection, markup.
 *
 * Both callers want the same three steps, and neither wants to know that it is
 * two queries — `postId` null is the create form, where nothing is selected yet.
 *
 * Returns null when the list cannot be read, rather than an empty picker. That
 * distinction matters on the edit form specifically: the write is replace-all,
 * so rendering the form without its checkboxes would make the next save wipe
 * whatever the post already offered. A failure has to be visible, not degraded.
 */
export async function renderShareTypePicker(env: Env, postId: number | null): Promise<string | null> {
	try {
		const [types, current] = await Promise.all([
			listShareTypes(env),
			postId === null ? Promise.resolve([] as ShareType[]) : listShareTypesForPost(env, postId),
		]);
		return shareTypeCheckboxes(types, new Set(current.map((type) => type.slug)));
	} catch (error) {
		console.error('Error loading share types:', error);
		return null;
	}
}

/**
 * The picker: checkboxes, not a `<select multiple>`.
 *
 * The subject picker on the same form is a multi-select with a "hold Ctrl" hint,
 * and that hint is the tell — a multi-select hides the fact that more than one
 * choice is allowed behind a keyboard convention. Offering a room *and* a car
 * seat on one post is the case this whole feature exists to serve, so the
 * control has to make multiple selection obvious at a glance. Checkboxes also
 * work on touch, where ctrl-click has no equivalent.
 */
function shareTypeCheckboxes(types: ShareType[], selected: Set<string>): string {
	if (types.length === 0) return '';

	return `<fieldset class="share-types">
		<legend>What are you sharing?</legend>
		<p class="field-hint">Check every one that applies — a single post can offer a room and a seat in the car.</p>
		<div class="share-type-options">${types
			.map(
				(type) => `<label class="share-type-option">
			<input type="checkbox" name="share_types" value="${escapeHtml(type.slug)}"${selected.has(type.slug) ? ' checked' : ''} />
			<span>${escapeHtml(type.name)}</span>
		</label>`,
			)
			.join('')}</div>
	</fieldset>`;
}

/**
 * The `<option>` list for the `/search?share=` filter, minus its blank option —
 * the caller supplies that, because only it knows what the blank one should say.
 *
 * Single-select on purpose: `searchPosts()` takes one slug, and "posts offering
 * a car seat" is the question people actually arrive with. A post offering
 * several still matches each of them, since the filter tests membership.
 */
export function shareTypeOptions(types: ShareType[], selected: string): string {
	return types
		.map(
			(type) =>
				`<option value="${escapeHtml(type.slug)}"${type.slug === selected ? ' selected' : ''}>${escapeHtml(type.name)}</option>`,
		)
		.join('');
}

/**
 * The badges shown on a post and on every result card.
 *
 * Returns the empty string for a post with no share types — every post created
 * before this feature is in that state, and they must render as they always did
 * rather than as an empty box.
 */
export function shareTypeBadges(types: ShareType[]): string {
	if (types.length === 0) return '';

	return `<div class="share-badges">${types
		.map((type) => `<span class="share-badge">${escapeHtml(type.name)}</span>`)
		.join('')}</div>`;
}

/**
 * The submitted share-type slugs, from either a form body or a query string.
 *
 * Unknown slugs are not rejected here — `setShareTypesForPost()` drops anything
 * outside the curated list, and validating in one place means the handlers
 * cannot disagree about what counts.
 */
export function submittedShareTypes(source: FormData | URLSearchParams): string[] {
	return source
		.getAll('share_types')
		.map((value) => String(value).trim())
		.filter(Boolean);
}
