import { NormalizeTitle, MatchScore, CompareSearchRows, SearchPageSize, type SearchSite, type SearchParameters, type SearchResult, type SearchRow } from './LocalSearch';
import { ReadSearchSite, ReadSearchRevisions } from './SearchDatabase';

interface CachedSite { revision: number; entries: { id: string; title: string; normalized: string; aliases?: string[] }[]; bytes: number; }
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
            const ranked: SearchRow[] = [], limit = offset + SearchPageSize;
            // A worst-first heap bounds cross-source ranking to the requested prefix, not all matches.
            const offer = (row: SearchRow) => {
                if (ranked.length < limit) {
                    ranked.push(row); let i = ranked.length - 1;
                    while (i > 0) { const parent = i - 1 >> 1; if (CompareSearchRows(ranked[parent], ranked[i]) <= 0) { [ranked[parent], ranked[i]] = [ranked[i], ranked[parent]]; i = parent; } else break; }
                } else if (CompareSearchRows(row, ranked[0]) < 0) {
                    ranked[0] = row; let i = 0;
                    while (i * 2 + 1 < ranked.length) { let child = i * 2 + 1; if (child + 1 < ranked.length && CompareSearchRows(ranked[child + 1], ranked[child]) > 0) child++; if (CompareSearchRows(ranked[child], ranked[i]) <= 0) break; [ranked[child], ranked[i]] = [ranked[i], ranked[child]]; i = child; }
                }
            };
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
                            const aliases = (Array.isArray(row.aliases) ? row.aliases : []).filter(alias => typeof alias === 'string').slice(0, 30).map(alias => NormalizeTitle(alias.slice(0, 1024)));
                            entries.push({ id: row.id, title: row.title, normalized, aliases }); bytes += 2 * (row.id.length + row.title.length + normalized.length + aliases.join('').length);
                        }
                        if (i % 500 === 499) await Yield();
                    }
                    check();
                    if (snapshot.revision !== null && entries.length <= 100000 && bytes <= 32 * 1024 * 1024) {
                        this.cache.delete(site.id); this.cache.set(site.id, { revision: snapshot.revision, entries, bytes });
                        while (this.cache.size > 2 || [...this.cache.values()].reduce((n, item) => n + item.entries.length, 0) > 100000 || [...this.cache.values()].reduce((n, item) => n + item.bytes, 0) > 64 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value!);
                    } else this.cache.delete(site.id);
                } else if (cached) { this.cache.delete(site.id); this.cache.set(site.id, cached); }
                let count = 0;
                const identities = new Set<string>();
                for (let i = 0; i < (entries?.length ?? 0); i++) {
                    check(); const row = entries![i];
                    if (!identities.has(row.id)) {
                        identities.add(row.id);
                        const score = !query && parameters.browse && parameters.siteId ? 1 : Math.max(MatchScore(row.normalized, query, parameters.fuzzy), ...(row.aliases ?? []).map(alias => Math.min(950, MatchScore(alias, query, parameters.fuzzy))));
                        if (score) { count++; offer({ siteId: site.id, mangaId: row.id, title: row.title, score }); }
                    }
                    if (i % 250 === 249) await Yield();
                }
                result.scanned += entries?.length ?? 0;
                result.groups.push({ site, count, metadata: snapshot.metadata, rows: [] });
                result.total += count; result.revisions[site.id] = snapshot.revision;
            }
            for (const row of ranked.sort(CompareSearchRows).slice(offset)) result.groups.find(group => group.site.id === row.siteId)!.rows.push(row);
            result.groups.sort((a, b) => (b.rows[0]?.score ?? -1) - (a.rows[0]?.score ?? -1) || a.site.title.localeCompare(b.site.title));
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
