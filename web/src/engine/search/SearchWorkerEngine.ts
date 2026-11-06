import { NormalizeTitle, MatchScore, CompareSearchRows, SearchPageSize, type SearchSite, type SearchParameters, type SearchResult, type SearchRow } from './LocalSearch';
import { ReadSearchSite, ReadSearchRevisions } from './SearchDatabase';

interface CachedSite { revision: number; entries: { id: string; title: string; normalized: string }[]; bytes: number; }
const Yield = () => new Promise<void>(resolve => {
    // Message tasks avoid nested setTimeout's 4ms clamp while still admitting newer worker requests.
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
});
export class SupersededSearch extends Error {}
/** Worker-owned derived cache. The sole persistent authority remains MediaLists and its atomic metadata. */
export class SearchWorkerEngine {
    private cache = new Map<string, CachedSite>();
    private serial = 0;
    constructor(private readonly read = ReadSearchSite, private readonly revisions = ReadSearchRevisions) {}
    public Cancel(): void { this.serial++; }
    public async Search(parameters: SearchParameters, sites: SearchSite[]): Promise<SearchResult> {
        const serial = ++this.serial;
        const check = () => { if (serial !== this.serial) throw new SupersededSearch(); };
        const start = performance.now();
        const selected = sites.filter(site => !parameters.siteId || site.id === parameters.siteId).toSorted((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
        const query = NormalizeTitle(parameters.query);
        let result: SearchResult;
        // A revision change during a long scan invalidates the entire response rather than labeling it current.
        for (let retry = 0; retry < 2; retry++) {
            check();
            result = { total: 0, page: parameters.page, pageSize: SearchPageSize, groups: [], elapsedMs: 0, revisions: Object.create(null), cachedEntries: 0, estimatedCacheBytes: 0, scanned: 0 };
            const offset = (parameters.page - 1) * SearchPageSize;
            for (const site of selected) {
                check();
                const cached = this.cache.get(site.id);
                const snapshot = await this.read(site.id, cached?.revision); check();
                let entries = cached?.entries;
                if (snapshot.entries) {
                    entries = [];
                    let bytes = 0;
                    for (let i = 0; i < snapshot.entries.length; i++) {
                        check(); const row = snapshot.entries[i];
                        if (typeof row?.id === 'string' && typeof row.title === 'string') {
                            const normalized = NormalizeTitle(row.title);
                            entries.push({ id: row.id, title: row.title, normalized }); bytes += 2 * (row.id.length + row.title.length + normalized.length);
                        }
                        if (i % 500 === 499) await Yield();
                    }
                    check();
                    if (snapshot.revision !== null && entries.length <= 100000 && bytes <= 32 * 1024 * 1024) {
                        this.cache.delete(site.id); this.cache.set(site.id, { revision: snapshot.revision, entries, bytes });
                        while (this.cache.size > 2 || [...this.cache.values()].reduce((n, item) => n + item.entries.length, 0) > 100000 || [...this.cache.values()].reduce((n, item) => n + item.bytes, 0) > 64 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value!);
                    } else this.cache.delete(site.id);
                } else if (cached) { this.cache.delete(site.id); this.cache.set(site.id, cached); }
                const matches: SearchRow[] = [];
                const identities = new Set<string>();
                for (let i = 0; i < (entries?.length ?? 0); i++) {
                    check(); const row = entries![i];
                    if (!identities.has(row.id)) { identities.add(row.id); const score = MatchScore(row.normalized, query, parameters.fuzzy); if (score) matches.push({ siteId: site.id, mangaId: row.id, title: row.title, score }); }
                    if (i % 250 === 249) await Yield();
                }
                result.scanned += entries?.length ?? 0;
                matches.sort(CompareSearchRows);
                const from = Math.max(0, offset - result.total), remaining = SearchPageSize - result.groups.reduce((n, group) => n + group.rows.length, 0);
                result.groups.push({ site, count: matches.length, metadata: snapshot.metadata, rows: remaining > 0 ? matches.slice(from, from + remaining) : [] });
                result.total += matches.length; result.revisions[site.id] = snapshot.revision;
            }
            const current = await this.revisions(selected.map(site => site.id)); check();
            if (selected.every(site => current[site.id] === result.revisions[site.id])) {
                result.elapsedMs = performance.now() - start;
                result.cachedEntries = [...this.cache.values()].reduce((n, item) => n + item.entries.length, 0);
                result.estimatedCacheBytes = [...this.cache.values()].reduce((n, item) => n + item.bytes, 0);
                return result;
            }
        }
        throw new Error('Catalog revisions are changing; retry local search');
    }
}
