import { describe, it, expect } from 'vitest';
import { parseRouteId } from '../src/lib/params';

/**
 * Route ids come straight from the URL, and parseInt() is too permissive to key
 * a row on: parseInt("12abc", 10) is 12, which Number.isFinite() accepts. That
 * turned a malformed URL into a successful lookup of an unrelated row.
 */
describe('parseRouteId', () => {
    it('accepts a plain positive integer', () => {
        expect(parseRouteId('1')).toBe(1);
        expect(parseRouteId('42')).toBe(42);
    });

    it('rejects trailing junk that parseInt would silently truncate', () => {
        expect(parseRouteId('12abc')).toBeNull();
        expect(parseRouteId('12 ')).toBeNull();
        expect(parseRouteId('12.5')).toBeNull();
        expect(parseRouteId('12e3')).toBeNull();
        expect(parseRouteId('0x10')).toBeNull();
    });

    it('rejects non-numeric, empty and missing values', () => {
        expect(parseRouteId('abc')).toBeNull();
        expect(parseRouteId('')).toBeNull();
        expect(parseRouteId(null)).toBeNull();
        expect(parseRouteId(undefined)).toBeNull();
    });

    it('rejects zero, negatives and signs', () => {
        expect(parseRouteId('0')).toBeNull();
        expect(parseRouteId('-1')).toBeNull();
        expect(parseRouteId('+1')).toBeNull();
    });

    it('rejects ids past the safe-integer range', () => {
        expect(parseRouteId('9007199254740993')).toBeNull();
    });
});
