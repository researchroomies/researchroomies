/**
 * When a conference is over, and what that closes.
 *
 * A conference archives itself: there is no column and no sweep job, because
 * "has the last day passed" is already answered by `conferences.stop_time` and a
 * stored flag would be a second answer that can disagree with it. Everything
 * derives from that one comparison, so a conference is archived at exactly the
 * same instant everywhere in the app.
 *
 * Archiving closes three things — the conference stops appearing in the
 * create-post picker, its posts stop accepting inquiries, and its posts stop
 * being editable. It deliberately does NOT hide anything: the conference page,
 * the /conferences index, /search and /my-posts all still list it, because the
 * post is a record of a trip that happened and a dead link is worse than a
 * clearly-labelled finished one. Deleting your own archived post still works —
 * archiving takes away the ability to make a stale offer, not the ability to
 * clean up after it.
 */

/**
 * How long after `stop_time` a conference stays live.
 *
 * `stop_time` is midnight UTC *at the start of* the last day (that is what the
 * date picker submits and what `createConference()` stores), so the last day has
 * not passed until a further 24 hours have. Without this a conference would
 * archive itself on the morning of its closing session.
 */
export const ARCHIVE_GRACE_SECONDS = 24 * 60 * 60;

/** Now, in the Unix seconds every timestamp in this schema is stored as. */
export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * The `stop_time` at or below which a conference is archived.
 *
 * Passed into the db layer as a plain number rather than computed there, so the
 * queries stay pure functions of their arguments and a test can ask for any
 * cutoff it likes without moving the system clock.
 */
export function archiveCutoff(now: number = nowSeconds()): number {
	return now - ARCHIVE_GRACE_SECONDS;
}

/** Whether a conference ending at `stopTime` is over. */
export function isArchivedStopTime(stopTime: number, now: number = nowSeconds()): boolean {
	return Number.isFinite(stopTime) && stopTime <= archiveCutoff(now);
}

/** The same question asked of any row that carries the conference's stop time. */
export function isArchived(row: { stop_time: number }, now: number = nowSeconds()): boolean {
	return isArchivedStopTime(row.stop_time, now);
}

/** The one sentence that explains, wherever a reader meets the closed state. */
export const ARCHIVED_NOTICE =
	'This conference has ended, so its posts are archived: they can no longer be edited and no longer accept inquiries.';
