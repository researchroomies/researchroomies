import { describe, it, expect } from 'vitest';
import { Router } from '../src/lib/router';

/**
 * Worker routes are registered without a trailing slash. Eleventy emits
 * directory-style pages, so /search/ is where the old static search page lived
 * and it still turns up in bookmarks and URL autocomplete — it must not 404.
 */
describe('Router matching', () => {
    const router = new Router();
    const ok = async () => new Response('ok');

    router.add('GET', '/search', ok);
    router.add('GET', '/my-posts', ok);
    router.add('GET', '/post/:id', ok);
    router.add('POST', '/post/:id/edit', ok);

    it('matches a registered path exactly', () => {
        expect(router.match('GET', '/search')).not.toBeNull();
        expect(router.match('GET', '/my-posts')).not.toBeNull();
    });

    it('extracts named params', () => {
        expect(router.match('GET', '/post/42')?.params).toEqual({ id: '42' });
        expect(router.match('POST', '/post/42/edit')?.params).toEqual({ id: '42' });
    });

    it('does not match a trailing slash directly', () => {
        // index.ts turns this miss into a 308 to the canonical path rather than
        // matching silently, so each route keeps exactly one URL.
        expect(router.match('GET', '/search/')).toBeNull();
        expect(router.match('GET', '/post/42/')).toBeNull();
    });

    it('recovers a route once the trailing slash is trimmed', () => {
        for (const path of ['/search/', '/my-posts/', '/post/42/', '/search//']) {
            const trimmed = path.replace(/\/+$/, '');
            expect(router.match('GET', trimmed), `${path} -> ${trimmed}`).not.toBeNull();
        }
    });

    it('leaves directory-style asset paths to the asset handler', () => {
        // Trimming these reveals no Worker route, so index.ts must not redirect
        // them — /about/ and /login/ are real Eleventy assets.
        for (const path of ['/about', '/login', '/create', '/terms']) {
            expect(router.match('GET', path), path).toBeNull();
        }
    });

    it('keeps methods separate', () => {
        expect(router.match('POST', '/search')).toBeNull();
        expect(router.match('GET', '/post/42/edit')).toBeNull();
    });
});
