/**
 * The two write-only tables: `flags` and `message`.
 *
 * Both record something that already happened, and neither is read back by the
 * application yet — flags are emailed to the admin address instead of being
 * reviewed in-app, and message rows are the record of inquiries sent. Grouped
 * together because they share that shape, not because moderation and messaging
 * are the same feature; split them if either grows a read path.
 */

import type { NewFlag, NewMessage } from './types';

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

/**
 * Records an inquiry that was sent through the platform.
 *
 * Called only after the mail provider has accepted the message, so a row here
 * means "this was actually sent" rather than "this was attempted". That ordering
 * is deliberate but has a cost — a mail outage records nothing — and is noted in
 * the backlog in CLAUDE.md.
 */
export async function recordMessage(env: Env, input: NewMessage): Promise<void> {
	await env.DB.prepare(
		`
		INSERT INTO message (post_id, sender_email, recipient_email, content, timestamp)
		VALUES (?, ?, ?, ?, ?)
	`,
	)
		.bind(input.postId, input.senderEmail, input.recipientEmail, input.content, input.timestamp)
		.run();
}
