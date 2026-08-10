/**
 * Route parameters are raw URL text, so an "id" is whatever the caller typed.
 *
 * parseInt() is too permissive to key a row on: parseInt("12abc", 10) is 12,
 * and Number.isFinite() accepts that happily, so a malformed URL silently
 * succeeds as a lookup of some unrelated row instead of 404ing. Require the
 * whole string to be digits.
 */
export function parseRouteId(raw: string | null | undefined): number | null {
    if (!raw || !/^\d+$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}
