import { getConfig } from './config';
import { escapeHtml } from './html';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * The client-side widget, for Worker-rendered forms.
 *
 * The sitekey used to be a literal repeated at four sites across two languages,
 * so rotating the widget meant four edits and a wrong key failed visibly only
 * on the page you happened to look at. It now comes from `[vars]` in
 * wrangler.toml; the two Nunjucks pages read the same var through an Eleventy
 * global. The Turnstile script itself is loaded by the page shell.
 */
export function turnstileWidget(env: Env): string {
    return `<div class="cf-turnstile" data-sitekey="${escapeHtml(getConfig(env).turnstileSiteKey)}"></div>`;
}

/**
 * Verifies a Turnstile token server-side.
 *
 * A missing token is a failure, not a skip. Callers previously guarded this with
 * `if (token) { verify }`, which meant anything that simply omitted the field
 * sailed through unchallenged.
 */
export async function verifyTurnstile(token: string | null, request: Request, env: Env): Promise<boolean> {
    if (!token) return false;

    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET_KEY);
    body.append('response', token);
    body.append('remoteip', request.headers.get('CF-Connecting-IP') || '');

    try {
        const resp = await fetch(SITEVERIFY_URL, { method: 'POST', body });
        const result = (await resp.json()) as { success?: boolean; 'error-codes'?: string[] };

        if (!result.success) {
            console.error('Turnstile verification failed:', result['error-codes']);
            return false;
        }
        return true;
    } catch (e) {
        console.error('Turnstile verification error:', e);
        return false;
    }
}
