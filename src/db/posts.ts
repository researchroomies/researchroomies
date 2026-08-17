/**
 * Every query against `posts`.
 *
 * The join to `conferences` is the important thing here. Four call sites — the
 * post page, the component fragment, the ownership guard and the report form —
 * each ran their own `posts JOIN conferences` with a slightly different column
 * list, which is three chances for one of them to drift and no single answer to
 * "what is a post". `getPostWithConference()` is that query, once.
 */

import type {
	NewPost,
	Post,
	PostAuthorContact,
	PostDetail,
	PostFields,
	PostWithConference,
	SearchFilters,
} from './types';

/**
 * The most posts `/search` will return.
 *
 * Exported because the results header says "(showing the first 50)" when the
 * page is full, and that sentence must not be able to disagree with the LIMIT.
 */
export const SEARCH_LIMIT = 50;

/** The columns behind `PostWithConference`, shared by the two listing queries. */
const POST_WITH_CONFERENCE_COLUMNS = `
	posts.id,
	posts.title,
	posts.description,
	posts.created_at,
	conferences.name AS conference_name,
	conferences.slug AS conference_slug,
	conferences.location_address,
	conferences.start_time,
	conferences.stop_time
`;

/** A single post by id, without its conference. */
export async function getPost(env: Env, id: number): Promise<Post | null> {
	return await env.DB.prepare(`SELECT id, title, description, created_at FROM posts WHERE id = ?`)
		.bind(id)
		.first<Post>();
}

/**
 * A single post with the conference it belongs to and the id of its author.
 *
 * The one query behind `/post/:id`, `/api/components/post/:id`,
 * `requireOwnedPost()` and the report form.
 *
 * It selects the conference's dates and location as well as its name, because
 * the post page states them as facts beside the description — the reader's first
 * question about a room share is which nights it covers. The ownership guard and
 * the report form ignore the extra columns, which is the same deliberate
 * widening Task 3 made rather than keeping two near-identical shapes apart.
 */
export async function getPostWithConference(env: Env, id: number): Promise<PostDetail | null> {
	return await env.DB.prepare(
		`
		SELECT p.id, p.title, p.description, p.created_at, p.user_id, p.conference_id,
		       c.name AS conference_name, c.slug AS conference_slug,
		       c.location_address, c.start_time, c.stop_time
		FROM posts p
		JOIN conferences c ON p.conference_id = c.id
		WHERE p.id = ?
	`,
	)
		.bind(id)
		.first<PostDetail>();
}

/** The posts on a conference's own page, newest first. */
export async function listPostsForConference(env: Env, conferenceId: number): Promise<Post[]> {
	const { results } = await env.DB.prepare(
		`
		SELECT id, title, description, created_at
		FROM posts
		WHERE conference_id = ?
		ORDER BY created_at DESC
	`,
	)
		.bind(conferenceId)
		.all<Post>();
	return results ?? [];
}

/**
 * The newest posts across every conference — the homepage feed.
 *
 * Ordered by `created_at DESC`, which is the one thing that distinguishes it
 * from an unfiltered `searchPosts()`: that query sorts by conference start date
 * so that a search reads as an itinerary, whereas this one answers "what has
 * been posted lately". `limit` is interpolated rather than bound because SQLite
 * will not accept a placeholder in LIMIT; the caller's value is a module
 * constant, and `Math.trunc`/`Math.max` make it a number regardless.
 */
export async function listRecentPosts(env: Env, limit: number): Promise<PostWithConference[]> {
	const capped = Math.max(1, Math.min(50, Math.trunc(limit) || 1));
	const { results } = await env.DB.prepare(
		`
		SELECT ${POST_WITH_CONFERENCE_COLUMNS}
		FROM posts
		JOIN conferences ON posts.conference_id = conferences.id
		ORDER BY posts.created_at DESC
		LIMIT ${capped}
	`,
	).all<PostWithConference>();
	return results ?? [];
}

/** Everything one user has posted, newest first — the `/my-posts` page. */
export async function listPostsForUser(env: Env, userId: number): Promise<PostWithConference[]> {
	const { results } = await env.DB.prepare(
		`
		SELECT ${POST_WITH_CONFERENCE_COLUMNS}
		FROM posts
		JOIN conferences ON posts.conference_id = conferences.id
		WHERE posts.user_id = ?
		ORDER BY posts.created_at DESC
	`,
	)
		.bind(userId)
		.all<PostWithConference>();
	return results ?? [];
}

/** `%` and `_` are LIKE wildcards; a user typing them should match literally. */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * One filter: the SQL fragment and the bindings that fragment consumes.
 *
 * The pairing is the point. This was two parallel arrays — `conditions` and
 * `bindings` — pushed to in step, where appending a clause but forgetting its
 * binding (or pushing two in the wrong order) shifts every later `?` onto the
 * wrong value and produces wrong results rather than an error. Keeping a
 * fragment and its bindings in one object makes that class of bug unwritable
 * instead of merely tested for.
 */
interface Clause {
	sql: string;
	bindings: (string | number)[];
}

function buildSearchClauses(filters: SearchFilters): Clause[] {
	const clauses: Clause[] = [];
	const q = filters.q?.trim();
	const conference = filters.conference?.trim();
	const tag = filters.tag?.trim();
	const share = filters.share?.trim();

	if (q) {
		const pattern = `%${escapeLike(q)}%`;
		clauses.push({
			sql: `(posts.title LIKE ? ESCAPE '\\' OR posts.description LIKE ? ESCAPE '\\')`,
			bindings: [pattern, pattern],
		});
	}
	if (conference) {
		clauses.push({
			sql: `conferences.name LIKE ? ESCAPE '\\'`,
			bindings: [`%${escapeLike(conference)}%`],
		});
	}
	if (tag) {
		clauses.push({
			sql: `conferences.id IN (SELECT conference_id FROM conference_tags WHERE tag_slug = ?)`,
			bindings: [tag],
		});
	}
	// Membership, not equality: a post offering both a room and a car seat has
	// two rows here, and must match a filter on either one. A JOIN would return
	// the post twice when a future filter matches more than one row.
	if (share) {
		clauses.push({
			sql: `posts.id IN (SELECT post_id FROM post_share_types WHERE share_slug = ?)`,
			bindings: [share],
		});
	}
	// A conference matches the range if it overlaps it: it must not have ended
	// before the lower bound, nor started after the upper one.
	if (filters.overlapsFrom !== undefined && filters.overlapsFrom !== null) {
		clauses.push({ sql: `conferences.stop_time >= ?`, bindings: [filters.overlapsFrom] });
	}
	if (filters.overlapsUntil !== undefined && filters.overlapsUntil !== null) {
		clauses.push({ sql: `conferences.start_time <= ?`, bindings: [filters.overlapsUntil] });
	}

	return clauses;
}

/**
 * The `/search` query. Any subset of the filters, including none of them.
 *
 * Capped at {@link SEARCH_LIMIT}; callers that report the count compare against
 * that constant rather than against a literal.
 */
export async function searchPosts(env: Env, filters: SearchFilters): Promise<PostWithConference[]> {
	const clauses = buildSearchClauses(filters);
	const where = clauses.length > 0 ? `WHERE ${clauses.map((clause) => clause.sql).join(' AND ')}` : '';
	const bindings = clauses.flatMap((clause) => clause.bindings);

	const stmt = env.DB.prepare(`
		SELECT ${POST_WITH_CONFERENCE_COLUMNS}
		FROM posts
		JOIN conferences ON posts.conference_id = conferences.id
		${where}
		ORDER BY conferences.start_time ASC, posts.created_at DESC
		LIMIT ${SEARCH_LIMIT}
	`);

	const { results } = await (bindings.length > 0 ? stmt.bind(...bindings) : stmt).all<PostWithConference>();
	return results ?? [];
}

/** Where an inquiry about a post should be delivered, and about what. */
export async function getPostAuthorContact(env: Env, postId: number): Promise<PostAuthorContact | null> {
	return await env.DB.prepare(
		`
		SELECT u.email, p.title
		FROM posts p
		JOIN users u ON p.user_id = u.id
		WHERE p.id = ?
	`,
	)
		.bind(postId)
		.first<PostAuthorContact>();
}

/** Inserts a post and returns its new id. */
export async function createPost(env: Env, input: NewPost): Promise<number> {
	const result = await env.DB.prepare(
		`
		INSERT INTO posts (user_id, conference_id, title, description, created_at)
		VALUES (?, ?, ?, ?, ?)
		RETURNING id
	`,
	)
		.bind(input.userId, input.conferenceId, input.title, input.description, input.createdAt)
		.first<{ id: number }>();

	if (!result) throw new Error('Failed to create post');
	return result.id;
}

/**
 * Edits a post's own fields.
 *
 * `userId` is in the WHERE as defence in depth: callers reach this through
 * `requireOwnedPost()`, which has already re-loaded the row and compared
 * ownership, so the clause is redundant — but a bug there must not become a way
 * to edit someone else's post.
 */
export async function updatePost(env: Env, id: number, userId: number, fields: PostFields): Promise<void> {
	await env.DB.prepare(`UPDATE posts SET title = ?, description = ? WHERE id = ? AND user_id = ?`)
		.bind(fields.title, fields.description, id, userId)
		.run();
}

/**
 * Deletes a post together with the flags that reference it.
 *
 * `message` rows are deliberately left behind: they are the record of inquiries
 * actually sent, and outlive the post they were about. As in `updatePost`, the
 * `AND user_id = ?` is defence in depth behind `requireOwnedPost()`.
 */
export async function deletePostAndFlags(env: Env, id: number, userId: number): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM flags WHERE post_id = ?`).bind(id),
		env.DB.prepare(`DELETE FROM posts WHERE id = ? AND user_id = ?`).bind(id, userId),
	]);
}
