/**
 * The two ways a post's author is drawn: as the create/edit fields, and as a
 * line of text on everything that lists a post.
 *
 * In lib/ rather than in a route module for the same reason as share-types.ts:
 * more than one route module needs it and none of them may import each other —
 * the create-form fragment (components.ts), the edit form (posts.ts), the post
 * page (post-detail.ts) and the listings (search.ts, my-posts.ts,
 * conferences.ts, components.ts).
 *
 * Institution is rendered here alongside position even though it is free text
 * with no table behind it. The two are one question — "who is posting, and from
 * where" — asked in one fieldset and answered in one line; splitting them across
 * two modules would mean the create form and the edit form could drift on half
 * of it, which is exactly what having a shared renderer is for.
 */

import { escapeHtml } from './html';
import { listPositions, OTHER_POSITION, resolvePosition } from '../db/positions';
import type { Position, PositionInput } from '../db/types';

/** What the fields are pre-filled with: an existing post, or nothing on create. */
export interface AuthorFieldValues {
	position_slug: string | null;
	position_other: string | null;
	institution: string | null;
}

/**
 * A post as far as the byline is concerned — the display name the LEFT JOIN
 * resolved, the free text behind 'Other Position', and the institution.
 */
export interface AuthorInfo {
	position_name: string | null;
	position_other: string | null;
	institution: string | null;
}

/**
 * The position as a reader should see it.
 *
 * The free text wins when it is there. `position_other` is non-null only for
 * `other`, whose stored name is the literal 'Other Position' — a label that
 * tells a reader nothing, when the author has typed the thing it stands for.
 */
export function positionLabel(post: AuthorInfo): string | null {
	return post.position_other || post.position_name;
}

/**
 * The one-line byline for a post in a list: position, institution, or both.
 *
 * Returns the empty string when neither is stated, so a post written before
 * these fields existed renders exactly as it always did rather than as an empty
 * separator. That is the same rule `shareTypeBadges()` follows, and it is not
 * optional: the columns are nullable on purpose and cannot be backfilled.
 */
export function authorLine(post: AuthorInfo): string {
	const parts = [positionLabel(post), post.institution].filter(Boolean) as string[];
	if (parts.length === 0) return '';

	return `<p class="post-author">${parts.map((part) => escapeHtml(part)).join(' &middot; ')}</p>`;
}

/**
 * The create/edit fields, ready to interpolate: curated list, current values,
 * markup.
 *
 * Returns null when the list cannot be read, and **both** callers treat that as
 * fatal — which is the deliberate difference from `renderShareTypePicker()`,
 * whose create-form caller degrades to no picker. Share types are optional, so
 * losing the picker costs a nicety. Position and institution are required, so a
 * form rendered without them is a form that cannot be submitted successfully;
 * showing it would waste everything else the user had typed.
 */
export async function renderAuthorFields(env: Env, current: AuthorFieldValues | null): Promise<string | null> {
	try {
		const positions = await listPositions(env);
		if (positions.length === 0) return null;
		return authorFieldsMarkup(positions, current);
	} catch (error) {
		console.error('Error loading positions:', error);
		return null;
	}
}

/**
 * A single select plus a free-text box that appears only for 'Other Position'.
 *
 * The reveal is an inline `onchange`, not a script file and not a framework.
 * The create page already toggles its new-conference block exactly this way, so
 * this adds no new mechanism to the site — the only JavaScript here is still
 * HTMX and Turnstile.
 *
 * `required` is set on the free-text box by the same handler rather than in the
 * markup: a `required` field that is `hidden` blocks submission with a browser
 * message pointing at a control nobody can see. The server enforces the same
 * rule regardless (`resolvePosition()` rejects 'other' with an empty box), so
 * this is a courtesy, not the check.
 */
function authorFieldsMarkup(positions: Position[], current: AuthorFieldValues | null): string {
	const selectedSlug = current?.position_slug ?? '';
	const isOther = selectedSlug === OTHER_POSITION;

	const options = positions
		.map(
			(position) =>
				`<option value="${escapeHtml(position.slug)}"${position.slug === selectedSlug ? ' selected' : ''}>${escapeHtml(position.name)}</option>`,
		)
		.join('');

	const reveal =
		`const other = document.getElementById('position-other-field');` +
		`other.hidden = this.value !== '${OTHER_POSITION}';` +
		`document.getElementById('position_other').required = !other.hidden;`;

	return `<fieldset class="author-fields">
		<legend>About you</legend>
		<p class="field-hint">Your position and where you are based. This is what makes you verifiable to a stranger, and it is the first thing people check.</p>
		<div class="field">
			<label for="position_slug">Position</label>
			<select class="input" id="position_slug" name="position_slug" required onchange="${escapeHtml(reveal)}">
				<option value="">Select your position…</option>
				${options}
			</select>
		</div>
		<div class="field" id="position-other-field"${isOther ? '' : ' hidden'}>
			<label for="position_other">Your position</label>
			<input class="input" id="position_other" type="text" name="position_other" maxlength="120"
			       placeholder="Research scientist, emeritus, industry researcher…"
			       value="${escapeHtml(current?.position_other ?? '')}"${isOther ? ' required' : ''} />
		</div>
		<div class="field">
			<label for="institution">Institution / affiliation</label>
			<input class="input" id="institution" type="text" name="institution" maxlength="200" required
			       placeholder="University of Michigan"
			       value="${escapeHtml(current?.institution ?? '')}" />
			<p class="field-hint">Free text — write it however your department writes it.</p>
		</div>
	</fieldset>`;
}

/**
 * The submitted position and institution, validated together: either the pair a
 * write can take, or the 400 to return.
 *
 * Here rather than in a route module because create and edit must apply the
 * identical rule, and because this is the one place that knows the fields are
 * mandatory — the same knowledge `renderAuthorFields()` puts into the markup
 * above it. Splitting the two apart is how a form and its handler come to
 * disagree about what is required.
 *
 * It returns a `Response` instead of throwing, following `src/lib/guards.ts`:
 * the failure stays an ordinary `return` at the call site, so no caller has to
 * know whether it sits inside a `try`.
 *
 * The contrast with `submittedShareTypes()` is the thing to keep straight. That
 * one hands its slugs to a write that silently drops the unknown ones, because
 * share types are optional and dropping one leaves a post the author could have
 * chosen anyway. A dropped position would leave a post with no position at all,
 * written through a form that says the field is required — so this rejects.
 */
export async function readAuthorFields(
	env: Env,
	formData: FormData,
): Promise<{ ok: true; position: PositionInput; institution: string } | { ok: false; response: Response }> {
	const institution = (formData.get('institution') as string | null)?.trim() ?? '';
	if (!institution) {
		return { ok: false, response: new Response('Please give your institution or affiliation.', { status: 400 }) };
	}

	const position = await resolvePosition(
		env,
		formData.get('position_slug') as string | null,
		formData.get('position_other') as string | null,
	);
	if (!position) {
		return {
			ok: false,
			response: new Response('Please choose your position, and describe it if you chose Other Position.', {
				status: 400,
			}),
		};
	}

	return { ok: true, position, institution };
}
