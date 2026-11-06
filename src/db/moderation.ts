/**
 * Every query against `flags`, the reports readers make about posts.
 *
 * Inquiries used to live here too, as the other write-only table. They moved to
 * messages.ts once `message` grew a read path.
 */

import type { NewFlag } from './types';

/**
 * Records a report against a post.
 *
 * This row is the source of truth for moderation. The notification email that
 * follows it is best-effort and must never be what makes a report exist.
 */
export async function recordFlag(env: Env, input: NewFlag): Promise<void> {
	await env.DB.prepare(`INSERT INTO flags (post_id, reason, flagged_by, timestamp) VALUES (?, ?, ?, ?)`)
		.bind(input.postId, input.reason, input.flaggedBy, input.timestamp)
		.run();
}
