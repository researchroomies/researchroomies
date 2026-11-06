/**
 * Every query against `flags`, the reports readers make about posts.
 *
 * Inquiries used to live here too, as the other write-only table. They moved to
 * messages.ts once `message` grew a read path.
 *
 * A report is never removed by anything in the application, including deleting
 * the post it is about. That is why `flags` has no foreign key to `posts` and
 * carries its own copy of the post (migration 0007).
 */

import type { NewFlag } from './types';

/**
 * Records a report against a post and returns its id.
 *
 * This row is the source of truth for moderation. The notification email that
 * follows it is best-effort and must never be what makes a report exist.
 */
export async function recordFlag(env: Env, input: NewFlag): Promise<number> {
	const row = await env.DB.prepare(
		`
		INSERT INTO flags (post_id, reason, flagged_by, timestamp, post_title, post_description, post_user_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		RETURNING id
	`,
	)
		.bind(
			input.postId,
			input.reason,
			input.flaggedBy,
			input.timestamp,
			input.postTitle,
			input.postDescription,
			input.postUserId,
		)
		.first<{ id: number }>();

	if (!row) throw new Error('Failed to record flag');
	return row.id;
}

/**
 * Records that the admin email for a report went out.
 *
 * A report whose email failed keeps `notified_at` NULL. That NULL is the only
 * trace of the failure outside the logs, and the list a retry or an admin page
 * would start from.
 */
export async function markFlagNotified(env: Env, id: number, at: number): Promise<void> {
	await env.DB.prepare(`UPDATE flags SET notified_at = ? WHERE id = ?`).bind(at, id).run();
}

/**
 * Whether `reporterEmail` has already reported this post.
 *
 * Checked by the handler rather than enforced by a UNIQUE index, because
 * production may already hold duplicates and an index would mean deleting some.
 * The race this leaves (two simultaneous reports from one person) costs a
 * duplicate row and a second email, which is what used to happen every time.
 */
export async function hasReported(env: Env, postId: number, reporterEmail: string): Promise<boolean> {
	const row = await env.DB.prepare(`SELECT 1 AS found FROM flags WHERE post_id = ? AND flagged_by = ? LIMIT 1`)
		.bind(postId, reporterEmail)
		.first<{ found: number }>();
	return row !== null;
}
