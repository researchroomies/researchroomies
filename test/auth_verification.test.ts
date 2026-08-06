import { describe, it, expect } from 'vitest';
import { generateMagicLinkToken, verifyMagicLinkToken, generateSessionToken, verifySessionToken, isEmailAllowed } from '../src/lib/auth';

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

    describe('isEmailAllowed (RESTRICT_EDU_EMAILS gate)', () => {
        const withFlag = (value: unknown) => ({ RESTRICT_EDU_EMAILS: value } as unknown as Env);

        it('allows everything when the flag is absent (default)', () => {
            expect(isEmailAllowed('someone@gmail.com', {} as Env)).toBe(true);
            expect(isEmailAllowed('someone@uni.edu', {} as Env)).toBe(true);
        });

        it('allows everything when the flag is anything other than "true"', () => {
            for (const value of ['false', '', 'no', '0', undefined, null]) {
                expect(isEmailAllowed('someone@gmail.com', withFlag(value))).toBe(true);
            }
        });

        it('restricts to .edu when the flag is "true"', () => {
            const env = withFlag('true');
            expect(isEmailAllowed('prof@university.edu', env)).toBe(true);
            expect(isEmailAllowed('prof@mail.university.edu', env)).toBe(true);
            expect(isEmailAllowed('someone@gmail.com', env)).toBe(false);
            expect(isEmailAllowed('someone@company.com', env)).toBe(false);
        });

        it('is case- and whitespace-insensitive on both the flag and the address', () => {
            expect(isEmailAllowed('  Prof@University.EDU  ', withFlag(' TRUE '))).toBe(true);
            expect(isEmailAllowed('Someone@Gmail.com', withFlag('True'))).toBe(false);
        });

        it('rejects international academic domains — the documented tradeoff', () => {
            const env = withFlag('true');
            expect(isEmailAllowed('researcher@ox.ac.uk', env)).toBe(false);
            expect(isEmailAllowed('researcher@unimelb.edu.au', env)).toBe(false);
        });

        it('is not fooled by .edu appearing outside the domain suffix', () => {
            const env = withFlag('true');
            expect(isEmailAllowed('edu@gmail.com', env)).toBe(false);
            expect(isEmailAllowed('someone@edu.com', env)).toBe(false);
        });
    });
});
