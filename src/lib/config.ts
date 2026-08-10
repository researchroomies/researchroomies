/**
 * Deployment configuration — the single place a value that differs between
 * environments (or that appears in more than one file) is defined.
 *
 * Everything here was previously a literal scattered across `src/routes/`,
 * `src/lib/` and `templates/pages/`. **Every default reproduces the literal it
 * replaced exactly**, so a deployment that sets none of the optional vars
 * behaves identically to the code before this module existed.
 *
 * Two of these were duplicated rather than merely scattered, and duplication is
 * the reason this module exists:
 *
 * - The session TTL was defined independently in `lib/auth.ts` (the token's
 *   `exp`) and `routes/auth.ts` (the cookie's `Max-Age`). They agreed by
 *   coincidence. Divergence means either a cookie carrying an already-dead
 *   token — a silent logout — or a live token thrown away early.
 * - The Turnstile sitekey appeared four times across two languages.
 *
 * The Turnstile sitekey is the one value NOT defined here: it lives in `[vars]`
 * in `wrangler.toml`, because Eleventy needs it at build time and cannot read
 * TypeScript. `eleventy.config.js` reads it from that same file and fails the
 * build if it is missing, so `npm run deploy` cannot ship a broken widget.
 */

/**
 * 30 days. Sets **both** the session token's `exp` claim and the session
 * cookie's `Max-Age`. Callers must derive both from this one value; see
 * `handleAuthCallback`.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * 15 minutes. Sets the magic-link token's `exp` claim and the "valid for N
 * minutes" copy in the login email and the expired-link page.
 */
export const MAGIC_LINK_TTL_SECONDS = 900;

/** Used only when no request is available and `APP_ORIGIN` is unset. */
const DEFAULT_ORIGIN = 'https://researchroomies.com';
const DEFAULT_MAILGUN_DOMAIN = 'researchroomies.com';
/** Region-specific. EU-region Mailgun domains must use https://api.eu.mailgun.net/v3. */
const DEFAULT_MAILGUN_API_BASE = 'https://api.mailgun.net/v3';
const DEFAULT_ADMIN_EMAIL = 'admin@researchroomies.com';

export interface MailgunConfig {
    domain: string;
    apiBase: string;
    /**
     * The configured From address, normalized to a full address, or `null` when
     * `MAILGUN_SENDING_KEY` is unset.
     *
     * `null` is not "no sender" — it means each message falls back to its own
     * local part at `domain` (`login@…` for the magic link, `noreply@…` for
     * everything else), which is what the code did before this module.
     *
     * `MAILGUN_SENDING_KEY` is misnamed: it is a From address, not a key. The
     * name is kept because renaming it means rotating a deployed secret.
     */
    from: string | null;
}

export interface AppConfig {
    /** Absolute origin, no trailing slash. Used to build emailed links. */
    origin: string;
    sessionTtlSeconds: number;
    magicLinkTtlSeconds: number;
    turnstileSiteKey: string;
    mailgun: MailgunConfig;
    adminEmail: string;
}

/** Treats absent, empty and whitespace-only env values identically. */
function configured(value: string | undefined): string | undefined {
    const trimmedValue = value?.trim();
    return trimmedValue ? trimmedValue : undefined;
}

/**
 * `APP_ORIGIN` if set, otherwise the origin of the request being served.
 *
 * Deriving from the request is what makes the login flow testable outside
 * production: under `wrangler dev` this is `http://localhost:<port>`, so a
 * magic link is clickable locally with no configuration at all. In production
 * it is `https://researchroomies.com` — the value that used to be hardcoded.
 *
 * The literal is still the last resort, for callers with no request in hand
 * (`sendReportEmail` builds a post link from an email-sending path).
 */
function resolveOrigin(env: Env, request?: Request): string {
    const override = configured(env.APP_ORIGIN);
    if (override) return override.replace(/\/+$/, '');

    if (request) {
        try {
            return new URL(request.url).origin;
        } catch {
            // Fall through to the default rather than failing a page render.
        }
    }

    return DEFAULT_ORIGIN;
}

function resolveMailgunFrom(env: Env, domain: string): string | null {
    const from = configured(env.MAILGUN_SENDING_KEY);
    if (!from) return null;
    return from.includes('@') ? from : `${from}@${domain}`;
}

/**
 * Resolves deployment configuration for one request.
 *
 * `request` is optional so background/email paths can call it; omitting it only
 * affects `origin`, which then falls back to `APP_ORIGIN` or the production
 * literal.
 */
export function getConfig(env: Env, request?: Request): AppConfig {
    const mailgunDomain = configured(env.MAILGUN_DOMAIN) ?? DEFAULT_MAILGUN_DOMAIN;

    return {
        origin: resolveOrigin(env, request),
        sessionTtlSeconds: SESSION_TTL_SECONDS,
        magicLinkTtlSeconds: MAGIC_LINK_TTL_SECONDS,
        // No default: [vars] in wrangler.toml is the single definition, and the
        // Eleventy build refuses to run without it.
        turnstileSiteKey: configured(env.TURNSTILE_SITE_KEY) ?? '',
        mailgun: {
            domain: mailgunDomain,
            apiBase: (configured(env.MAILGUN_API_BASE) ?? DEFAULT_MAILGUN_API_BASE).replace(/\/+$/, ''),
            from: resolveMailgunFrom(env, mailgunDomain),
        },
        adminEmail: configured(env.ADMIN_EMAIL) ?? DEFAULT_ADMIN_EMAIL,
    };
}

/**
 * Renders a TTL as the human copy used in emails and on the expired-link page,
 * so the prose cannot drift from the actual token lifetime.
 *
 * `MAGIC_LINK_TTL_SECONDS` (900) renders as "15 minutes", which is exactly what
 * those strings said before.
 */
export function formatTtlMinutes(seconds: number): string {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
