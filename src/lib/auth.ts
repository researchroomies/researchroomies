import { MAGIC_LINK_TTL_SECONDS, SESSION_TTL_SECONDS } from './config';

export interface MagicLinkPayload {
    v: number;
    email: string;
    iat: number;
    exp: number;
    aud: 'magiclink';
    iss: 'researchroomies';
}

export interface SessionPayload {
    v: number;
    sub: string;
    email: string;
    iat: number;
    exp: number;
    aud: 'session';
    iss: 'researchroomies';
}

/**
 * What a rejected address is told, in one place.
 *
 * `handleAuthStart` returns it as the body of its 403 and the login page shows
 * that body verbatim in a dialog; `handleAuthCallback` renders it into a page
 * for anyone who reaches the gate from an already-issued link. Keeping it here
 * rather than in either handler is what lets the static login page display the
 * server's wording without the build having to know about it.
 */
export const EDU_RESTRICTION_MESSAGE =
    'At this time, ResearchRoomies is only available to users with a .edu email address. ' +
    'This restriction helps us limit access to members of the academic community and improve ' +
    'the safety of our service. We apologize for any inconvenience.';

/**
 * Optional .edu-only gate, controlled by the RESTRICT_EDU_EMAILS var in
 * wrangler.toml. Fails open: anything other than the literal string "true"
 * (including the var being absent) allows every address through.
 *
 * The check is a strict `.edu` suffix, so it also rejects international
 * academic domains such as .ac.uk and .edu.au. See CLAUDE.md before enabling.
 */
export function isEmailAllowed(email: string, env: Env): boolean {
    const restricted = String(env.RESTRICT_EDU_EMAILS ?? '').trim().toLowerCase() === 'true';
    if (!restricted) return true;

    return email.trim().toLowerCase().endsWith('.edu');
}

// Utilities for base64url encoding/decoding
function base64urlEncode(buffer: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Constant-time string/buffer comparison
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(payload)
    );

    return base64urlEncode(new Uint8Array(signature));
}

export async function generateMagicLinkToken(
    email: string,
    secret: string,
    ttlSeconds: number = MAGIC_LINK_TTL_SECONDS
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: MagicLinkPayload = {
        v: 1,
        email,
        iat: now,
        exp: now + ttlSeconds,
        aud: 'magiclink',
        iss: 'researchroomies'
    };

    const payloadStr = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const signature = await sign(payloadStr, secret);
    return `${payloadStr}.${signature}`;
}

export async function verifyMagicLinkToken(token: string, secret: string): Promise<MagicLinkPayload | null> {
    const [payloadStr, signature] = token.split('.');
    if (!payloadStr || !signature) return null;

    // Verify signature
    const expectedSignature = await sign(payloadStr, secret);
    // Using timingSafeEqual for constant time comparison
    // Because sign returns a string, we need to convert back to Uint8Array or just compare strings if we trust the length check?
    // Actually, timingSafeEqual operates on Uint8Arrays. Let's convert.
    const sigBytes = new TextEncoder().encode(signature);
    const expectedSigBytes = new TextEncoder().encode(expectedSignature);

    if (!timingSafeEqual(sigBytes, expectedSigBytes)) return null;

    try {
        const jsonStr = new TextDecoder().decode(base64urlDecode(payloadStr));
        const payload = JSON.parse(jsonStr) as MagicLinkPayload;

        const now = Math.floor(Date.now() / 1000);

        if (
            payload.v !== 1 ||
            payload.aud !== 'magiclink' ||
            payload.iss !== 'researchroomies' ||
            now > payload.exp
        ) {
            return null;
        }

        return payload;
    } catch (e) {
        return null;
    }
}

/**
 * `ttlSeconds` defaults to the same constant the session cookie's `Max-Age` is
 * built from. Callers should still pass it explicitly from `getConfig()` so the
 * cookie and the token are demonstrably derived from one value.
 */
export async function generateSessionToken(
    userLastLoginAt: number,
    email: string,
    userId: string,
    secret: string,
    ttlSeconds: number = SESSION_TTL_SECONDS
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
        v: 1,
        sub: userId,
        email,
        iat: now,
        exp: now + ttlSeconds,
        aud: 'session',
        iss: 'researchroomies'
    };

    const payloadStr = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const signature = await sign(payloadStr, secret);
    return `${payloadStr}.${signature}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
    const [payloadStr, signature] = token.split('.');
    if (!payloadStr || !signature) return null;

    const expectedSignature = await sign(payloadStr, secret);
    const sigBytes = new TextEncoder().encode(signature);
    const expectedSigBytes = new TextEncoder().encode(expectedSignature);

    if (!timingSafeEqual(sigBytes, expectedSigBytes)) return null;

    try {
        const jsonStr = new TextDecoder().decode(base64urlDecode(payloadStr));
        const payload = JSON.parse(jsonStr) as SessionPayload;
        const now = Math.floor(Date.now() / 1000);

        if (
            payload.v !== 1 ||
            payload.aud !== 'session' ||
            payload.iss !== 'researchroomies' ||
            now > payload.exp
        ) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}
