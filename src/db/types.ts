/**
 * Every row shape the application reads, defined exactly once.
 *
 * Before this file a post was spelled out six different ways — the `Post`
 * interface, `PostForEdit`, `PostForDelete`, `PostOwner`, plus anonymous inline
 * types in three handlers — and none of them was authoritative. Four
 * `as unknown as` casts then laundered the mismatches past the type checker.
 * The clearest case: `getAllConferences()` was typed `Promise<Conference[]>`
 * while its query was `SELECT id, name`, so five declared fields did not exist
 * on the objects it returned and TypeScript was perfectly happy.
 *
 * The rule that keeps that from coming back: **a type here describes exactly
 * the columns its query selects.** `ConferenceSummary` is a distinct type from
 * `Conference` for that reason — it is what `SELECT id, name` really produces,
 * and having the narrow type available is what makes the wide lie unwritable.
 * Queries pass these to D1's generics (`.first<T>()` / `.all<T>()`); there is no
 * cast anywhere in `src/db/`.
 */

/** A conference as the browse and detail pages render it. */
export interface ConferenceListing {
	id: number;
	name: string;
	slug: string;
	location_address: string;
	start_time: number;
	stop_time: number;
}

/** A full conference row, i.e. a listing plus the prose only its own page shows. */
export interface Conference extends ConferenceListing {
	description: string | null;
}

/**
 * What `SELECT id, name FROM conferences` actually returns.
 *
 * Only the create-post `<option>` list needs this, and it needs nothing else.
 * Keeping it separate from `Conference` is what makes the old type lie
 * impossible to restate.
 */
export interface ConferenceSummary {
	id: number;
	name: string;
}

/** A conference on a subject page, carrying its post count from a GROUP BY. */
export interface ConferenceWithPostCount extends ConferenceListing {
	post_count: number;
}

/** A post on its own, as the conference page lists it. */
export interface Post {
	id: number;
	title: string;
	description: string;
	created_at: number;
}

/**
 * A post joined to the conference it belongs to, for the lists that show both.
 *
 * `/search` and `/my-posts` each used to select their own near-identical subset
 * of these columns. They now select the same ones and share this type; each
 * renderer still uses only the fields it needs.
 */
export interface PostWithConference extends Post {
	conference_name: string;
	conference_slug: string;
	location_address: string;
	start_time: number;
	stop_time: number;
}

/**
 * A single post with its conference and its author's id.
 *
 * One shape behind four pages — `/post/:id`, the component fragment, the
 * ownership guard and the report form — which between them used to run three
 * near-identical `posts JOIN conferences` queries with slightly different column
 * lists. `user_id` is here because ownership is decided against it.
 */
export interface PostDetail {
	id: number;
	title: string;
	description: string;
	user_id: number;
	conference_id: number;
	conference_name: string;
	conference_slug: string;
}

/** Where an inquiry about a post gets delivered. */
export interface PostAuthorContact {
	email: string;
	title: string;
}

/** A curated subject tag. */
export interface Tag {
	slug: string;
	name: string;
}

/**
 * A subject tag carrying the conference it is attached to.
 *
 * The sibling of `PostShareType`, and it exists for the same reason: the
 * all-conferences page needs every conference's subjects at once, and reading
 * them with `listTagsForConference()` per row would be a query per conference.
 * `listTagsForConferences()` selects them in one statement and groups by this
 * column.
 */
export interface ConferenceTag extends Tag {
	conference_id: number;
}

/**
 * One of the curated things a post offers to share — lodging, a carpool seat,
 * a rental car, an airport transfer, or something else.
 *
 * A post carries any number of these, including none: every post that predates
 * the feature has none, and the pickers are optional, so "untyped" is a normal
 * state rather than a migration gap. Renderers must handle the empty list.
 */
export interface ShareType {
	slug: string;
	name: string;
}

/**
 * A share type carrying the post it belongs to.
 *
 * This exists for the one query that reads badges for a whole result page at
 * once. Fetching them per post would be a query per row — 50 on a full `/search`
 * page — so `listShareTypesForPosts()` selects them in a single statement and
 * groups by this column.
 */
export interface PostShareType extends ShareType {
	post_id: number;
}

/** A user row, as login reads it back. */
export interface User {
	id: number;
	email: string;
	created_at: number;
}

/* ------------------------------------------------------------------ writes */

export interface NewConference {
	userId: number;
	name: string;
	slug: string;
	/** `"City, State"`, or null when neither was given. */
	locationAddress: string | null;
	startTime: number;
	stopTime: number;
	createdAt: number;
}

export interface NewPost {
	userId: number;
	conferenceId: number;
	title: string;
	description: string;
	createdAt: number;
}

/** The columns `updatePost` is allowed to change. */
export interface PostFields {
	title: string;
	description: string;
}

export interface NewFlag {
	postId: number;
	reason: string;
	flaggedBy: string;
	timestamp: number;
}

export interface NewMessage {
	postId: number;
	senderEmail: string;
	recipientEmail: string;
	content: string;
	timestamp: number;
}

/**
 * The filters `/search` supports. Every field is optional; omitting all of them
 * is the unfiltered listing.
 *
 * The two date bounds are an *overlap* test, not a containment one: a conference
 * matches `overlapsFrom` if it has not already finished by then, and
 * `overlapsUntil` if it has started by then. Named for that meaning rather than
 * for the `start` / `end` query parameters they come from, because the parameter
 * names read as the opposite of the columns they compare against.
 */
export interface SearchFilters {
	/** Matched against post title and description. */
	q?: string;
	/** Matched against the conference name. */
	conference?: string;
	/** An exact tag slug. */
	tag?: string;
	/**
	 * An exact share-type slug. A post matches if it offers this among others,
	 * so filtering by `carpool` still finds the post that offers a room too.
	 */
	share?: string;
	/** Unix seconds; keeps conferences whose `stop_time` is at or after this. */
	overlapsFrom?: number | null;
	/** Unix seconds; keeps conferences whose `start_time` is at or before this. */
	overlapsUntil?: number | null;
}
