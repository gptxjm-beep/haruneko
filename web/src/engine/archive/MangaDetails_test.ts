import { describe, expect, it } from 'vitest';
import { MangaDetailsURL } from './MangaDetails';
describe('Optional manga detail source identity', () => {
    it('Should resolve a public connector path and a Madara stable slug without changing source identity', () => {
        const site = new URL('https://fixture.invalid');
        expect(MangaDetailsURL(site, '/manga/one/').href).toBe('https://fixture.invalid/manga/one/');
        expect(MangaDetailsURL(site, JSON.stringify({ post: '10', slug: '/manga/one/' })).pathname).toBe('/manga/one/');
    });
    it('Should refuse cross-origin, numeric and query-dependent identities rather than guessing a manga URL', () => {
        const site = new URL('https://fixture.invalid');
        for (const value of ['https://other.invalid/manga/one/', '12345', '/?id=123', 'https://user:password@fixture.invalid/manga/one/']) expect(() => MangaDetailsURL(site, value)).toThrow();
    });
});
