/**
 * Every query against `users`.
 *
 * There is only one, because a magic link is the only way an account comes into
 * existence: clicking a valid link either signs an existing user in or creates
 * them. There is no registration step to write separately.
 */

import type { User } from './types';

/**
 * Signs a verified email address in, creating the account if it is new, and
 * returns the user id.
 *
 * The caller has already verified the magic-link token, so the address is proven
 * to belong to whoever clicked. `now` is passed in rather than read from the
 * clock here so that the session token's `iat` and the row's `last_login_at`
 * record the same instant.
 */
export async function upsertUserOnLogin(env: Env, email: string, now: number): Promise<number> {
	const existing = await env.DB.prepare(`SELECT id, email, created_at FROM users WHERE email = ?`)
		.bind(email)
		.first<User>();

	if (!existing) {
		const created = await env.DB.prepare(
			`INSERT INTO users (email, created_at, last_login_at) VALUES (?, ?, ?) RETURNING id`,
		)
			.bind(email, now, now)
			.first<{ id: number }>();

		if (!created) throw new Error('Failed to create user');
		return created.id;
	}

	await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(now, existing.id).run();
	return existing.id;
}
