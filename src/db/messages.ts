/**
 * Every query against `message`, the record of inquiries sent through the site.
 *
 * Split out of moderation.ts when this table grew a read path. That module's
 * doc said to do exactly this once either of its two write-only tables needed
 * one.
 *
 * A row is a small state machine, and these functions are its only transitions:
 *
 *   startMessage()          → 'pending'   written before the email is sent
 *   settleMessage(… 'sent')   → 'sent'      Mailgun accepted it
 *   settleMessage(… 'failed') → 'failed'    Mailgun refused it, or was unreachable
 *
 * Writing the row first is what lets a retry see the earlier attempt. Before
 * migration 0006 the row was written after the send, so a D1 error at that point
 * returned a 500 for an email that had already gone out, and the retry sent it
 * again.
 */

import type { MessageStatus, NewMessage } from './types';

/** Records an inquiry about to be sent, and returns its id for settling. */
export async function startMessage(env: Env, input: NewMessage): Promise<number> {
	const row = await env.DB.prepare(
		`
		INSERT INTO message (post_id, sender_email, recipient_email, content, timestamp, status)
		VALUES (?, ?, ?, ?, ?, 'pending')
		RETURNING id
	`,
	)
		.bind(input.postId, input.senderEmail, input.recipientEmail, input.content, input.timestamp)
		.first<{ id: number }>();

	if (!row) throw new Error('Failed to record message');
	return row.id;
}

/**
 * Settles a pending inquiry once the send has an outcome.
 *
 * Only a 'pending' row moves. A settled row is history, and nothing should be
 * able to turn a 'sent' into a 'failed' after the fact.
 */
export async function settleMessage(env: Env, id: number, status: Exclude<MessageStatus, 'pending'>): Promise<void> {
	await env.DB.prepare(`UPDATE message SET status = ? WHERE id = ? AND status = 'pending'`).bind(status, id).run();
}

/**
 * Whether this exact inquiry was already sent, or may have been, since `since`.
 *
 * Matches on the content as well as the post and sender, so a second, different
 * message to the same author is never swallowed. 'pending' counts as sent: see
 * `MessageStatus`.
 */
export async function hasRecentMessage(
	env: Env,
	input: { postId: number; senderEmail: string; content: string; since: number },
): Promise<boolean> {
	const row = await env.DB.prepare(
		`
		SELECT 1 AS found FROM message
		WHERE post_id = ? AND sender_email = ? AND content = ? AND timestamp >= ?
		  AND status IN ('pending', 'sent')
		LIMIT 1
	`,
	)
		.bind(input.postId, input.senderEmail, input.content, input.since)
		.first<{ found: number }>();
	return row !== null;
}

/**
 * Whether `senderEmail` has ever had an inquiry about this post go out.
 *
 * Backs the "your inquiry was sent" notice. The `?sent=1` the send handler
 * redirects to only asks the question, so a crafted or bookmarked link shows
 * nothing to someone who never sent anything.
 */
export async function hasSentMessage(env: Env, postId: number, senderEmail: string): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT 1 AS found FROM message WHERE post_id = ? AND sender_email = ? AND status IN ('pending', 'sent') LIMIT 1`,
	)
		.bind(postId, senderEmail)
		.first<{ found: number }>();
	return row !== null;
}
