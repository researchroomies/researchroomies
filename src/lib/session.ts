import { verifySessionToken, type SessionPayload } from './auth';

export const COOKIE_NAME = 'rr_session';

function parseCookies(header: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return cookies;
}

/**
 * Resolves the signed session cookie to its payload, or null when the request
 * is anonymous or the token is missing/expired/tampered.
 */
export async function getSessionUser(request: Request, env: Env): Promise<SessionPayload | null> {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return null;

    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!token) return null;

    return await verifySessionToken(token, env.AUTH_HMAC_SECRET);
}

/** `sub` carries `users.id` as a string; callers comparing against DB columns need the number. */
export function sessionUserId(user: SessionPayload): number {
    return Number(user.sub);
}
