import { generateMagicLinkToken, verifyMagicLinkToken, generateSessionToken, verifySessionToken } from '../lib/auth';
import { sendMagicLink } from '../lib/mailgun';

const APP_ORIGIN = "https://researchroomies.com";
const COOKIE_NAME = "rr_session";
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days

export async function handleAuthStart(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    try {
        const body = await request.json() as { email: string; cf_turnstile_response: string };
        const { email, cf_turnstile_response } = body;

        if (!email || !cf_turnstile_response) {
            return new Response('Missing email or Turnstile response', { status: 400 });
        }

        // 1. Verify Turnstile
        const turnstileBody = new FormData();
        turnstileBody.append('secret', env.TURNSTILE_SECRET_KEY);
        turnstileBody.append('response', cf_turnstile_response);
        turnstileBody.append('remoteip', request.headers.get('CF-Connecting-IP') || '');

        const turnVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: turnstileBody,
        });

        const turnResult = await turnVerify.json() as any;
        if (!turnResult.success) {
            // In dev, maybe we can skip strict Turnstile if it fails? But instructions say "Required".
            // I'll log failure but maybe for now if using dummy keys it might work if client uses dummy sitekey.
            console.error("Turnstile failed:", turnResult);
            return new Response('Invalid Turnstile', { status: 400 });
        }

        // 2. Normalize email
        const normalizedEmail = email.trim().toLowerCase();
        // Basic validity check
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            return new Response('Invalid email format', { status: 400 });
        }

        // 3. Create magic-link token
        const token = await generateMagicLinkToken(normalizedEmail, env.AUTH_HMAC_SECRET);

        // 4. Email link
        const link = `${APP_ORIGIN}/api/auth/callback?token=${encodeURIComponent(token)}`;

        // 5. Send Email
        const sent = await sendMagicLink(normalizedEmail, link, env);

        // Log for dev (since we can't see emails)
        console.log("MAGIC LINK GENERATED:", link);

        if (!sent) {
            console.error("Failed to send email to", normalizedEmail);
            // Instructions: "Always return { ok: true }"
        }

        return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error("Auth start error:", e);
        return new Response('Internal Error', { status: 500 });
    }
}

export async function handleAuthCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
        return new Response('Missing token', { status: 400 });
    }

    // 1. Verify Token
    const payload = await verifyMagicLinkToken(token, env.AUTH_HMAC_SECRET);
    if (!payload) {
        return new Response('Invalid or expired token', { status: 400 });
    }

    // 2. Upsert user
    const db = env.DB;
    // Check if user exists
    let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(payload.email).first<{ id: number, email: string, created_at: number }>();

    let userId: string; // Since we kept ID as INTEGER, we need to handle it.
    // Wait, if users.id is INTEGER PRIMARY KEY, sqlite handles auto-increment.
    // We shouldn't generate UUID.

    const now = Math.floor(Date.now() / 1000);

    if (!user) {
        // Create new user
        const result = await db.prepare('INSERT INTO users (email, created_at, last_login_at) VALUES (?, ?, ?) RETURNING id')
            .bind(payload.email, now, now)
            .first<{ id: number }>();

        if (!result) throw new Error("Failed to create user");
        userId = result.id.toString();
    } else {
        // Update last login
        await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
            .bind(now, user.id)
            .run();
        userId = user.id.toString();
    }

    // 3. Issue session token
    const sessionToken = await generateSessionToken(now, payload.email, userId, env.AUTH_HMAC_SECRET);

    // 4. Set cookie and redirect
    const headers = new Headers();
    headers.append('Set-Cookie', `${COOKIE_NAME}=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`);
    headers.append('Location', '/');

    return new Response(null, {
        status: 302,
        headers: headers
    });
}

export async function handleAuthLogout(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const headers = new Headers();
    headers.append('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);

    return new Response(JSON.stringify({ ok: true }), {
        headers: {
            ...Object.fromEntries(headers),
            'Content-Type': 'application/json'
        }
    }); // Note: If called via API, JSON is fine. If via browser nav, might want redirect. Instructions say "Return { ok: true }".
}

export async function handleAuthMe(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) {
        return new Response(JSON.stringify({ user: null }), { headers: { 'Content-Type': 'application/json' } });
    }

    const cookies = Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=')));
    const token = cookies[COOKIE_NAME];

    if (!token) {
        return new Response(JSON.stringify({ user: null }), { headers: { 'Content-Type': 'application/json' } });
    }

    const payload = await verifySessionToken(token, env.AUTH_HMAC_SECRET);
    if (!payload) {
        return new Response(JSON.stringify({ user: null }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ user: payload }), { headers: { 'Content-Type': 'application/json' } });
}
