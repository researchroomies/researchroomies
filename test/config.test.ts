import { describe, it, expect } from 'vitest';
import { env as workerEnv } from 'cloudflare:test';
import {
    MAGIC_LINK_TTL_SECONDS,
    SESSION_TTL_SECONDS,
    formatTtlMinutes,
    getConfig,
} from '../src/lib/config';
import { generateSessionToken } from '../src/lib/auth';
import { magicLinkUrl } from '../src/routes/auth';

const env = (overrides: Record<string, unknown> = {}) => overrides as unknown as Env;
const req = (url: string) => new Request(url);

/**
 * These assertions exist to pin the pre-refactor literals. Every default below
 * is the value that was hardcoded somewhere in src/ before src/lib/config.ts
 * existed; if one of them changes, production behaviour changes with it.
 */
describe('getConfig defaults reproduce the literals they replaced', () => {
    it('falls back to the production origin when there is no request and no override', () => {
        expect(getConfig(env()).origin).toBe('https://researchroomies.com');
    });

    it('uses the production Mailgun domain, API base and admin address', () => {
        const config = getConfig(env());
        expect(config.mailgun.domain).toBe('researchroomies.com');
        expect(config.mailgun.apiBase).toBe('https://api.mailgun.net/v3');
        expect(config.adminEmail).toBe('admin@researchroomies.com');
    });

    it('keeps the 30-day session and 15-minute magic-link lifetimes', () => {
        const config = getConfig(env());
        expect(config.sessionTtlSeconds).toBe(30 * 24 * 60 * 60);
        expect(config.magicLinkTtlSeconds).toBe(900);
    });
});

describe('origin resolution', () => {
    it('derives the origin from the request, so dev is not pinned to production', () => {
        expect(getConfig(env(), req('http://localhost:8805/api/auth/start')).origin)
            .toBe('http://localhost:8805');
    });

    it('ignores the path, query and fragment of the request', () => {
        expect(getConfig(env(), req('https://example.test/post/7?sent=1')).origin)
            .toBe('https://example.test');
    });

    it('lets APP_ORIGIN override the request origin', () => {
        expect(getConfig(env({ APP_ORIGIN: 'https://staging.example.test' }), req('http://localhost:8805/x')).origin)
            .toBe('https://staging.example.test');
    });

    it('strips a trailing slash from APP_ORIGIN so links do not double up', () => {
        expect(getConfig(env({ APP_ORIGIN: 'https://staging.example.test/' })).origin)
            .toBe('https://staging.example.test');
    });

    it('treats an empty or whitespace-only APP_ORIGIN as unset', () => {
        expect(getConfig(env({ APP_ORIGIN: '   ' }), req('http://localhost:8805/x')).origin)
            .toBe('http://localhost:8805');
    });
});

/**
 * The whole point of the origin change: the magic link used to be built from a
 * hardcoded production literal, so a link generated under `wrangler dev` was
 * unclickable and the login flow could only be exercised in production.
 */
describe('magicLinkUrl', () => {
    it('points at localhost under wrangler dev with no configuration', () => {
        const config = getConfig(env(), req('http://localhost:8805/api/auth/start'));
        expect(magicLinkUrl(config, 'abc.def')).toBe(
            'http://localhost:8805/api/auth/callback?token=abc.def'
        );
    });

    it('points at production when serving production', () => {
        const config = getConfig(env(), req('https://researchroomies.com/api/auth/start'));
        expect(magicLinkUrl(config, 'abc.def')).toBe(
            'https://researchroomies.com/api/auth/callback?token=abc.def'
        );
    });

    it('percent-encodes the token', () => {
        const config = getConfig(env({ APP_ORIGIN: 'https://example.test' }));
        expect(magicLinkUrl(config, 'a+b/c=d')).toBe(
            'https://example.test/api/auth/callback?token=a%2Bb%2Fc%3Dd'
        );
    });
});

describe('Mailgun From address resolution', () => {
    it('falls back to the per-message local part when MAILGUN_SENDING_KEY is unset', () => {
        // null means "use this message's own local part" — login@ for the magic
        // link, noreply@ for everything else. It does not mean "no sender".
        expect(getConfig(env()).mailgun.from).toBeNull();
    });

    it('appends the Mailgun domain to a bare local part', () => {
        expect(getConfig(env({ MAILGUN_SENDING_KEY: 'login' })).mailgun.from)
            .toBe('login@researchroomies.com');
    });

    it('uses a full address as-is', () => {
        expect(getConfig(env({ MAILGUN_SENDING_KEY: 'login@example.test' })).mailgun.from)
            .toBe('login@example.test');
    });

    it('appends the overridden domain, not the default one', () => {
        expect(getConfig(env({ MAILGUN_SENDING_KEY: 'login', MAILGUN_DOMAIN: 'mail.example.test' })).mailgun.from)
            .toBe('login@mail.example.test');
    });

    it('treats an empty value as unset, as the previous falsy check did', () => {
        expect(getConfig(env({ MAILGUN_SENDING_KEY: '' })).mailgun.from).toBeNull();
    });
});

describe('Turnstile sitekey', () => {
    it('comes from [vars], which the test runner loads from wrangler.toml', () => {
        // Not asserting the literal key here — wrangler.toml is its single
        // definition, and duplicating it in a test would recreate the drift
        // this task removed. Assert only that it is present and plausible.
        expect(workerEnv.TURNSTILE_SITE_KEY).toMatch(/^0x[A-Za-z0-9]+$/);
        expect(getConfig(workerEnv).turnstileSiteKey).toBe(workerEnv.TURNSTILE_SITE_KEY);
    });

    it('is empty rather than a stale hardcoded default when the var is missing', () => {
        expect(getConfig(env()).turnstileSiteKey).toBe('');
    });
});

describe('formatTtlMinutes', () => {
    it('renders the magic-link TTL as the exact prose the emails used to hardcode', () => {
        expect(formatTtlMinutes(MAGIC_LINK_TTL_SECONDS)).toBe('15 minutes');
    });

    it('singularizes one minute', () => {
        expect(formatTtlMinutes(60)).toBe('1 minute');
    });

    it('never claims zero minutes for a sub-minute TTL', () => {
        expect(formatTtlMinutes(20)).toBe('1 minute');
    });
});

/**
 * The bug this task exists to prevent: the session cookie's Max-Age and the
 * session token's `exp` were derived from two independent constants in two
 * files. If they diverge, the cookie outlives the token (a silent logout) or
 * discards a still-valid one.
 */
describe('session lifetime is defined once', () => {
    it('puts SESSION_TTL_SECONDS between the token iat and exp', async () => {
        const token = await generateSessionToken(0, 'user@example.test', '1', 'secret', SESSION_TTL_SECONDS);
        const payload = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));

        expect(payload.exp - payload.iat).toBe(SESSION_TTL_SECONDS);
        expect(payload.exp - payload.iat).toBe(getConfig(env()).sessionTtlSeconds);
    });

    it('defaults to the same lifetime when a caller omits it', async () => {
        const token = await generateSessionToken(0, 'user@example.test', '1', 'secret');
        const payload = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));

        expect(payload.exp - payload.iat).toBe(SESSION_TTL_SECONDS);
    });
});
