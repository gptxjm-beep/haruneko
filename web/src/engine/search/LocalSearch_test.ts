import { describe, it, expect } from 'vitest';
import { NormalizeTitle, MatchScore, CompareSearchRows, ValidSearchPreference, StaleIndex } from './LocalSearch';
import { EmptyIndexSite } from '../catalog/SiteIndexContract';

describe('Local Arabic and English title matching', () => {
    it.each([
        ['إِرَادَةُ الأَبْطَال', 'ارادة الابطال'], ['آفاقُ ٱلْعَالَم', 'افاق العالم'], ['فتى ومؤمن ورئيس', 'فتي ومومن ورييس'],
        ['ＯＮＥ—Piece', 'one piece'], [' ونــ بيس  ', 'ون بيس'],
    ])('Should normalize search text without changing the original title: %s', (original, normalized) => { expect(NormalizeTitle(original)).toBe(normalized); });
    it('Should rank exact, prefix and partial title matches and ignore English case', () => {
        const query = NormalizeTitle('ONE PIECE');
        expect(MatchScore(NormalizeTitle('One Piece'), query, false)).toBe(1000);
        expect(MatchScore(NormalizeTitle('One Piece Colored'), query, false)).toBeGreaterThan(MatchScore(NormalizeTitle('The One Piece'), query, false));
        expect(MatchScore(NormalizeTitle('One Piece'), 'piece', false)).toBeGreaterThan(0);
        expect(MatchScore('unrelated', query, false)).toBe(0);
    });
    it('Should enable bounded approximate title matching only when requested', () => {
        expect(MatchScore('one piece', 'one peice', false)).toBe(0);
        expect(MatchScore('one piece', 'one peice', true)).toBeGreaterThan(0);
        expect(MatchScore('one piece', 'unrelated manga', true)).toBe(0);
        expect(MatchScore('one piece', 'on', true)).toBeGreaterThan(0); // Real substring, not approximate short-query matching.
        expect(MatchScore('one piece', 'ox', true)).toBe(0);
    });
    it('Should retain separate same-title identities and sort their scores deterministically', () => {
        const rows = [{ siteId: 'a', mangaId: '2', title: 'Same', score: 1000 }, { siteId: 'b', mangaId: '1', title: 'Same', score: 1000 }];
        expect(rows.toSorted(CompareSearchRows).map(row => [row.siteId, row.mangaId])).toEqual([['b', '1'], ['a', '2']]);
    });
    it('Should validate persisted preferences instead of accepting invalid page and scroll inputs', () => {
        expect(ValidSearchPreference({ query: 'x'.repeat(500), page: -1, scroll: Infinity, fuzzy: true })).toMatchObject({ query: 'x'.repeat(256), page: 1, scroll: 0, fuzzy: true });
        expect(ValidSearchPreference(undefined).siteId).toBe('');
    });
    it('Should distinguish fresh indexes from retained failures, missing dates and aged snapshots', () => {
        const site = { ...EmptyIndexSite('a'), lastSuccess: 1000000000, state: 'succeeded' as const };
        expect(StaleIndex(site, site.lastSuccess + 100)).toBe(false);
        expect(StaleIndex(site, site.lastSuccess + 8 * 86400000)).toBe(true);
        expect(StaleIndex({ ...site, state: 'stale' }, site.lastSuccess + 100)).toBe(true);
        expect(StaleIndex(EmptyIndexSite('a'))).toBe(true);
    });
});
