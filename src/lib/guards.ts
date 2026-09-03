import type { SessionPayload } from './auth';
import { ARCHIVED_NOTICE, isArchived } from './archive';
import { getPostWithConference } from '../db/posts';
import type { PostDetail } from '../db/types';
import { parseRouteId } from './params';
import { errorPage, forbiddenPage, notFoundPage } from './response';
import { getSessionUser, sessionUserId } from './session';

/**
 * The result of a guard: either the value the handler wanted, or the Response
 * it should return instead.
 *
 * Deliberately a value rather than a thrown exception. The failure stays an
 * ordinary `return` in the handler, so control flow is visible at the call site
 * and no guard needs to know whether it happens to sit inside a `try`.
 */
export type Guard<T> = { ok: true; value: T } | { ok: false; response: Response };

const fail = (response: Response): Guard<never> => ({ ok: false, response });

/**
 * How a handler answers an unauthenticated request.
 *
 * This is the one place the rule is written down. It used to be folklore: the
 * same condition produced three different answers across ten handlers, and a
 * new handler picked one at random.
 *
 *   'page' → 302 to /login
 *       Full page navigations. The browser follows it and the user lands on the
 *       login form, which is what they wanted.
 *
 *   'api'  → 401 "Unauthorized", plain text
 *       Form POSTs and JSON endpoints. There is no page to send anyone to; the
 *       correct answer is a refusal the caller can see.
 *
 *   'htmx' → 200 with an HX-Redirect header, empty body
 *       Fragments swapped into a live page. HTMX issues these with fetch(), which
 *       follows a 302 transparently and would swap the whole login page into a
 *       <div>. The redirect has to be handed to HTMX as a header instead — and it
 *       must be a 200, because HTMX ignores headers on a non-2xx by default.
 */
export type GuardMode = 'page' | 'api' | 'htmx';

function unauthenticated(request: Request, mode: GuardMode): Response {
	switch (mode) {
		case 'page':
			return Response.redirect(new URL('/login', request.url).href, 302);
		case 'api':
			return new Response('Unauthorized', { status: 401 });
		case 'htmx':
			return new Response('', { status: 200, headers: { 'HX-Redirect': '/login' } });
	}
}

/**
 * Requires a signed-in user, answering per `mode` when there is not one.
 *
 * See {@link GuardMode} for which mode a handler should ask for.
 */
export async function requireUser(
	request: Request,
	env: Env,
	mode: GuardMode,
): Promise<Guard<SessionPayload>> {
	const user = await getSessionUser(request, env);
	if (!user) return fail(unauthenticated(request, mode));
	return { ok: true, value: user };
}

/**
 * Resolves the session without requiring one.
 *
 * For handlers that render for anyone but render *differently* for the author —
 * the post page, the nav. Separate from `requireUser` so "anonymous is fine
 * here" is a deliberate word at the call site rather than a missing `if`, and so
 * `getSessionUser` has exactly one caller outside `routes/auth.ts`.
 */
export async function optionalUser(request: Request, env: Env): Promise<SessionPayload | null> {
	return await getSessionUser(request, env);
}

/**
 * The row `requireOwnedPost` hands back.
 *
 * It used to be a local interface here, declaring the superset of what the four
 * ownership handlers each SELECTed for themselves. It is now the same
 * `PostDetail` the post page and the report form get, from the same query — the
 * four hand-written shapes became one type in `src/db/types.ts`, so the
 * ownership check has one place to go missing from and one shape to go stale.
 */
export type OwnedPost = PostDetail;

/**
 * Session, id parse, row fetch and ownership check, in one call.
 *
 * The ownership comparison lived inline in four handlers, three steps each, and
 * every repetition was a chance to forget the middle one. The rule it enforces —
 * *never trust an id from a form body; re-check ownership against the DB row on
 * every mutating request* — is now structural rather than remembered.
 *
 * Always 'page' mode: all four call sites are browser navigations or plain form
 * POSTs. Failures are 302 (no session), 404 (bad id or no such post) and 403
 * (not yours) — a missing post and someone else's post are told apart on
 * purpose, because the id came from the address bar of a user who is signed in
 * and the distinction is not a leak worth hiding.
 *
 * Catches its own D1 errors so it is total: the caller may treat the returned
 * Response as final and needs no `try` around this call.
 */
export async function requireOwnedPost(
	request: Request,
	env: Env,
	params: Record<string, string> | undefined,
): Promise<Guard<{ user: SessionPayload; post: OwnedPost }>> {
	const guard = await requireUser(request, env, 'page');
	if (!guard.ok) return guard;
	const user = guard.value;

	const id = parseRouteId(params?.id);
	if (id === null) return fail(notFoundPage('Post'));

	let post: OwnedPost | null;
	try {
		post = await getPostWithConference(env, id);
	} catch (error) {
		console.error('Error loading post for ownership check:', error);
		return fail(errorPage());
	}

	if (!post) return fail(notFoundPage('Post'));
	if (post.user_id !== sessionUserId(user)) {
		return fail(forbiddenPage('You can only edit your own posts.'));
	}

	return { ok: true, value: { user, post } };
}

/**
 * `requireOwnedPost()`, plus the post's conference still being ahead of us.
 *
 * The edit pair asks for this; the delete pair deliberately does not. Archiving
 * exists to stop a stale offer being presented as a live one, and an edit is how
 * a post stays presented — so it closes with the conference, while deleting the
 * post it left behind stays available forever. Making that the difference
 * between two guards rather than an `if` in each handler is what keeps the two
 * edit entry points (the form and its submit) from drifting apart, which is the
 * same reason `requireOwnedPost()` exists at all.
 *
 * 403 rather than 404: the post is still there and still the caller's, and
 * saying so is the only way the refusal reads as "this is over" rather than as a
 * bug.
 */
export async function requireEditablePost(
	request: Request,
	env: Env,
	params: Record<string, string> | undefined,
): Promise<Guard<{ user: SessionPayload; post: OwnedPost }>> {
	const guard = await requireOwnedPost(request, env, params);
	if (!guard.ok) return guard;

	if (isArchived(guard.value.post)) return fail(forbiddenPage(ARCHIVED_NOTICE));

	return guard;
}
