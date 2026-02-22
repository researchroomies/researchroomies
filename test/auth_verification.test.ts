import { describe, it, expect } from 'vitest';
import { generateMagicLinkToken, verifyMagicLinkToken, generateSessionToken, verifySessionToken } from '../src/lib/auth';

const SECRET = 'test-secret-must-be-at-least-32-chars-long-so-here-is-some-padding';

describe('Auth Library', () => {
    describe('Magic Link', () => {
        it('should generate and verify a valid token', async () => {
            const email = 'test@example.com';
            const token = await generateMagicLinkToken(email, SECRET);

            expect(token).toBeDefined();

            const payload = await verifyMagicLinkToken(token, SECRET);
            expect(payload).not.toBeNull();
            expect(payload?.email).toBe(email);
            expect(payload?.aud).toBe('magiclink');
            expect(payload?.iss).toBe('researchroomies');
        });

        it('should reject a tampered token', async () => {
            const email = 'test@example.com';
            const token = await generateMagicLinkToken(email, SECRET);

            const tamperedToken = token.slice(0, -5) + 'xxxxx';
            const payload = await verifyMagicLinkToken(tamperedToken, SECRET);
            expect(payload).toBeNull();
        });

        it('should reject a token signed with wrong secret', async () => {
            const email = 'test@example.com';
            const token = await generateMagicLinkToken(email, SECRET);
            const wrongSecret = SECRET + '_wrong';

            const payload = await verifyMagicLinkToken(token, wrongSecret);
            expect(payload).toBeNull();
        });

        // Hard to test expiration without mocking Date, but could test very short TTL if param exposed or mock Date.now()
    });

    describe('Session Token', () => {
        it('should generate and verify a valid session token', async () => {
            const email = 'user@example.com';
            const userId = '123';
            const lastLogin = Math.floor(Date.now() / 1000);

            const token = await generateSessionToken(lastLogin, email, userId, SECRET);
            expect(token).toBeDefined();

            const payload = await verifySessionToken(token, SECRET);
            expect(payload).not.toBeNull();
            expect(payload?.sub).toBe(userId);
            expect(payload?.email).toBe(email);
            expect(payload?.aud).toBe('session');
        });
    });
});
