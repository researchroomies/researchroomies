import { generateMagicLinkToken, verifyMagicLinkToken, generateSessionToken, isEmailAllowed } from '../lib/auth';
import { sendMagicLink } from '../lib/mailgun';
import { COOKIE_NAME, getSessionUser } from '../lib/session';
import { verifyTurnstile } from '../lib/turnstile';
import { pageResponse } from '../lib/response';
import { formatTtlMinutes, getConfig, type AppConfig } from '../lib/config';

/**
 * Builds the link that goes in the login email.
 *
 * Split out from `handleAuthStart` so it can be asserted on without sending
 * mail: the origin used to be a hardcoded production literal, which meant the
 * only way to see what this produced was to receive a real email in production.
 */
export function magicLinkUrl(config: AppConfig, token: string): string {
    return `${config.origin}/api/auth/callback?token=${encodeURIComponent(token)}`;
}

/**
 * The callback is reached by clicking a link in an email, so failures land in
 * a browser address bar and must render a page rather than bare text.
 *
 * `heading` and `body` are developer-authored literals below — `body` contains
 * intentional markup (links back to /login) and is NOT escaped, so nothing
 * user-supplied may ever be passed here.
 */
function callbackErrorPage(heading: string, body: string, status: number): Response {
    return pageResponse(
        heading,
        `<div class="site-page"><h2>${heading}</h2><p>${body}</p></div>`,
        { status, cache: 'none' }
    );
}

export async function handleAuthStart(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const config = getConfig(env, request);

    try {
        const body = await request.json() as { email: string; cf_turnstile_response: string };
        const { email, cf_turnstile_response } = body;

        if (!email || !cf_turnstile_response) {
            return new Response('Missing email or Turnstile response', { status: 400 });
        }

        // 1. Verify Turnstile.
        // This used to be a hand-rolled siteverify fetch, which meant the login
        // route — where a bypass matters most — was the one place not going
        // through the module whose entire job is "a missing token is a failure,
        // not a skip".
        if (!await verifyTurnstile(cf_turnstile_response, request, env)) {
            return new Response('Invalid Turnstile', { status: 400 });
        }

        // 2. Normalize email
        const normalizedEmail = email.trim().toLowerCase();
        // Basic validity check
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            return new Response('Invalid email format', { status: 400 });
        }

        // 3. Optional institutional-email gate (RESTRICT_EDU_EMAILS)
        if (!isEmailAllowed(normalizedEmail, env)) {
            return new Response(
                `Accounts are currently limited to .edu email addresses. If you are an academic without one, email ${config.adminEmail} and we will get you set up.`,
                { status: 403 }
            );
        }

        // 4. Create magic-link token
        const token = await generateMagicLinkToken(normalizedEmail, env.AUTH_HMAC_SECRET, config.magicLinkTtlSeconds);

        // 5. Email link. The origin comes from the request unless APP_ORIGIN
        // overrides it, so `wrangler dev` emails a link back to localhost.
        const link = magicLinkUrl(config, token);

        // 6. Send Email
        // Never log `link` — it carries a valid login token for this address.
        const sent = await sendMagicLink(normalizedEmail, link, env);

        if (!sent) {
            // Must not report ok: the user would be told to check an inbox that
            // will never receive anything, and a broken mailer stays invisible.
            console.error("Failed to send magic link to", normalizedEmail);
            return new Response(
                `We could not send the login email just now. Please try again in a few minutes, or contact ${config.adminEmail} if the problem continues.`,
                { status: 502 }
            );
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
    const config = getConfig(env, request);

    if (!token) {
        return callbackErrorPage(
            'Login Link Incomplete',
            'That link is missing its login token. Please <a href="/login">request a new one</a>.',
            400
        );
    }

    try {
        // 1. Verify Token
        const payload = await verifyMagicLinkToken(token, env.AUTH_HMAC_SECRET);
        if (!payload) {
            return callbackErrorPage(
                'Login Link Expired',
                `This login link is invalid or has expired. Login links are good for ${formatTtlMinutes(config.magicLinkTtlSeconds)} &mdash; please <a href="/login">request a new one</a>.`,
                400
            );
        }

        // Re-check the gate here too, so flipping RESTRICT_EDU_EMAILS on takes
        // effect immediately rather than after the last issued link expires.
        if (!isEmailAllowed(payload.email, env)) {
            return callbackErrorPage(
                'Account Not Eligible',
                `Accounts are currently limited to .edu email addresses. If you are an academic without one, email <a href="mailto:${config.adminEmail}">${config.adminEmail}</a> and we will get you set up.`,
                403
            );
        }

        // 2. Upsert user
        const db = env.DB;
        // Check if user exists
        let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(payload.email).first<{ id: number, email: string, created_at: number }>();

        let userId: string;

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

        // 3. Issue session token.
        // The token's `exp` and the cookie's `Max-Age` below are derived from
        // this one local. They used to be two independent 30-day constants in
        // two files; if those ever diverged the cookie would outlive the token
        // (a silent logout) or discard a still-valid one.
        const sessionTtl = config.sessionTtlSeconds;
        const sessionToken = await generateSessionToken(now, payload.email, userId, env.AUTH_HMAC_SECRET, sessionTtl);

        // 4. Set cookie and redirect
        const headers = new Headers();
        headers.append('Set-Cookie', `${COOKIE_NAME}=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${sessionTtl}`);
        headers.append('Location', '/');

        return new Response(null, {
            status: 302,
            headers: headers
        });
    } catch (e) {
        // A throw here used to escape the handler entirely: the runtime returned
        // its own bare 500 and the user, mid-login from their inbox, saw nothing
        // explaining it or pointing back at /login.
        console.error("Auth callback error:", e);
        return callbackErrorPage(
            'Login Failed',
            `Something went wrong while signing you in. Please <a href="/login">try again</a>, or contact <a href="mailto:${config.adminEmail}">${config.adminEmail}</a> if it keeps happening.`,
            500
        );
    }
}

export async function handleAuthLogout(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const headers = new Headers();
    headers.append('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    headers.append('HX-Redirect', '/');

    return new Response(null, { status: 200, headers });
}

export async function handleAuthMe(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The only getSessionUser() call outside lib/guards.ts, and deliberately so:
    // this endpoint's whole purpose is to report the raw session, so there is no
    // guard decision to make. Everywhere else goes through requireUser() or
    // optionalUser(); test/session-access.test.ts holds that line.
    const user = await getSessionUser(request, env);

    return new Response(JSON.stringify({ user }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache' }
    });
}
