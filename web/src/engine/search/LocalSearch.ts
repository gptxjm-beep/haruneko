import type { IndexSite } from '../catalog/SiteIndexContract';

export interface SearchSite { id: string; title: string; }
export interface SearchParameters { query: string; siteId: string; fuzzy: boolean; page: number; browse?: boolean; }
export interface SearchRow { siteId: string; mangaId: string; title: string; score: number; }
export interface SearchGroup { site: SearchSite; count: number; metadata: IndexSite; rows: SearchRow[]; }
export interface SearchResult {
    total: number; page: number; pageSize: number; groups: SearchGroup[]; elapsedMs: number;
    revisions: Record<string, number | null>; cachedEntries: number; estimatedCacheBytes: number; scanned: number;
}
export const SearchPageSize = 25;
export const SearchPreferenceKey = 'frontend.classic.arabic-search';
export interface SearchPreference extends SearchParameters { active: boolean; scroll: number; }
export const EmptySearchPreference: SearchPreference = { query: '', siteId: '', fuzzy: false, page: 1, active: false, scroll: 0 };
export function ValidSearchPreference(value: Partial<SearchPreference>): SearchPreference {
    return { query: typeof value?.query === 'string' ? value.query.slice(0, 256) : '', siteId: typeof value?.siteId === 'string' ? value.siteId.slice(0, 512) : '',
        fuzzy: value?.fuzzy === true, page: Number.isSafeInteger(value?.page) && value.page > 0 ? value.page : 1,
        active: value?.active === true, scroll: Number.isFinite(value?.scroll) && value.scroll >= 0 ? Math.min(value.scroll, 10000000) : 0 };
}
/** Search-only normalization. Original titles and source identities are never rewritten. */
export function NormalizeTitle(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase('en').replace(/\p{M}/gu, '').replace(/\u0640/g, '')
        .replace(/[أإآٱ]/g, 'ا').replace(/[ىی]/g, 'ي').replace(/ک/g, 'ك').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function Distance(a: string, b: string, limit: number): number {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i]; let lowest = i;
        for (let j = 1; j <= b.length; j++) { const n = Math.min(previous[j] + 1, next[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); next.push(n); lowest = Math.min(lowest, n); }
        if (lowest > limit) return limit + 1;
        previous = next;
    }
    return previous[b.length];
}
export function MatchScore(title: string, query: string, fuzzy: boolean): number {
    if (!query) return 0;
    if (title === query) return 1000;
    const position = title.indexOf(query);
    if (position >= 0) return (position === 0 ? 900 : title[position - 1] === ' ' ? 850 : 800) + Math.max(0, 40 - (title.length - query.length));
    if (!fuzzy || query.length < 3 || query.length > 64) return 0;
    const limit = query.length < 6 ? 1 : 2;
    const words = title.slice(0, 512).split(' ').slice(0, 32), length = query.split(' ').length;
    let best = limit + 1;
    for (let i = 0; i < words.length; i++) for (const size of [length, length + 1]) {
        const sample = words.slice(i, i + size).join(' ');
        if (sample) best = Math.min(best, Distance(sample, query, limit));
    }
    return best <= limit && best / query.length <= 0.25 ? 600 - best * 50 : 0;
}
export const CompareSearchRows = (a: SearchRow, b: SearchRow) => b.score - a.score || a.title.localeCompare(b.title) || a.mangaId.localeCompare(b.mangaId);
export function StaleIndex(metadata: IndexSite, now = Date.now()): boolean {
    return !metadata.lastSuccess || now - metadata.lastSuccess > 7 * 86400000 || metadata.state !== 'succeeded';
}
