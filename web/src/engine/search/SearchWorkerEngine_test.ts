import { describe, expect, it } from 'vitest';
import { SearchWorkerEngine, SupersededSearch } from './SearchWorkerEngine';
import { EmptyIndexSite, type CatalogEntry } from '../catalog/SiteIndexContract';

function fixture() {
    const lists = new Map<string, CatalogEntry[]>([['a', [{ id: 'same', title: 'One Piece' }, { id: 'ar', title: 'إِرَادَةُ الأبطال' }]], ['b', [{ id: 'same', title: 'ONE PIECE' }]]]);
    const versions = new Map([['a', 1], ['b', 1]]), rebuilt: string[] = [];
    let stale = false;
    const engine = new SearchWorkerEngine(async (id, revision) => {
        const current = versions.get(id)!;
        const metadata = { ...EmptyIndexSite(id), revision: current, state: stale ? 'stale' as const : 'succeeded' as const, lastSuccess: 1000 };
        if (revision !== current) rebuilt.push(id);
        return { metadata, revision: current, entries: revision === current ? undefined : lists.get(id) };
    }, async ids => Object.fromEntries(ids.map(id => [id, versions.get(id)!])));
    const search = (query: string, page = 1, siteId = '') => engine.Search({ query, page, siteId, fuzzy: false }, [{ id: 'b', title: 'B source' }, { id: 'a', title: 'A source' }]);
    return { engine, lists, versions, rebuilt, search, makeStale() { stale = true; } };
}
describe('Revision-aware worker search over accepted catalogs', () => {
    it('Should browse only the requested saved site with the same engine and preserve ordinary empty-search semantics', async () => {
        const f = fixture();
        const browsed = await f.engine.Search({ query: '', page: 1, siteId: 'a', fuzzy: false, browse: true }, [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
        expect(browsed.total).toBe(2); expect(browsed.groups.flatMap(group => group.rows).every(row => row.siteId === 'a')).toBe(true);
        expect((await f.search('')).total).toBe(0);
    });
    it('Should rank an exact title in a later source above fuzzy matches and search explicit aliases without merging identities', async () => {
        const f = fixture();
        f.lists.set('a', Array.from({ length: 30 }, (_, n) => ({ id: String(n), title: 'One Pieca' })));
        f.lists.set('b', [{ id: 'exact', title: 'One Piece' }, { id: 'alias', title: 'ワンピース', aliases: ['ون بيس', 'One Piece'] }]);
        const result = await f.engine.Search({ query: 'one piece', page: 1, siteId: '', fuzzy: true }, [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
        expect(result.groups[0].rows.map(row => row.mangaId)).toEqual(['exact', 'alias']);
        expect((await f.search('ون بيس')).groups.flatMap(group => group.rows).map(row => row.mangaId)).toEqual(['alias']);
        expect((await f.search('ون بيس')).groups.flatMap(group => group.rows)[0].title).toBe('ワンピース');
    });
    it('Should group the same title in multiple sites without merging source identities', async () => {
        const f = fixture(), result = await f.search('one piece');
        expect(result.total).toBe(2);
        expect(result.groups.map(group => group.site.id)).toEqual(['a', 'b']);
        expect(result.groups.flatMap(group => group.rows.map(row => [row.siteId, row.mangaId]))).toEqual([['a', 'same'], ['b', 'same']]);
    });
    it('Should support Arabic normalization and site filtering with no results handled explicitly', async () => {
        const f = fixture();
        expect((await f.search('ارادة الابطال')).total).toBe(1);
        expect((await f.search('piece', 1, 'b')).total).toBe(1);
        expect((await f.search('not present')).total).toBe(0);
        expect(f.lists.get('a')![1].title).toBe('إِرَادَةُ الأبطال');
    });
    it('Should reuse normalized data only at the current revision and rebuild after a manual or bulk publication', async () => {
        const f = fixture(); await f.search('one'); await f.search('piece'); expect(f.rebuilt).toEqual(['a', 'b']);
        f.lists.set('a', [{ id: 'new', title: 'New Title' }]); f.versions.set('a', 2);
        expect((await f.search('one')).total).toBe(1);
        expect((await f.search('new')).groups.flatMap(group => group.rows).map(row => row.mangaId)).toEqual(['new']);
        expect(f.rebuilt).toEqual(['a', 'b', 'a']);
    });
    it('Should update stale status without removing accepted results or re-normalizing unchanged titles', async () => {
        const f = fixture(); await f.search('one'); f.makeStale(); const result = await f.search('one');
        expect(result.total).toBe(2); expect(result.groups.every(group => group.metadata.state === 'stale')).toBe(true);
        expect(f.rebuilt).toEqual(['a', 'b']);
    });
    it('Should paginate large matching sets without returning all results to the renderer', async () => {
        const f = fixture(); f.lists.set('a', Array.from({ length: 10000 }, (_, i) => ({ id: String(i), title: `Manga ${i}` })));
        const result = await f.search('manga', 200);
        expect(result.total).toBe(10000); expect(result.groups.flatMap(group => group.rows)).toHaveLength(25);
        expect(result.cachedEntries).toBeLessThanOrEqual(100000);
    });
    it('Should cancel a superseded scan and never return it as current', async () => {
        const f = fixture(); f.lists.set('a', Array.from({ length: 10000 }, (_, i) => ({ id: String(i), title: `Manga ${i}` })));
        const first = f.search('manga'); const rejected = expect(first).rejects.toBeInstanceOf(SupersededSearch);
        f.engine.Cancel(); await rejected;
        expect((await f.search('piece', 1, 'b')).total).toBe(1);
    });
    it('Should retry a revision changed during the scan and return only its new accepted data', async () => {
        let version = 1;
        const engine = new SearchWorkerEngine(async () => ({ metadata: EmptyIndexSite('a'), revision: version, entries: [{ id: String(version), title: version === 1 ? 'Old' : 'New' }] }), async () => { version = 2; return { a: 2 }; });
        const result = await engine.Search({ query: 'new', page: 1, siteId: '', fuzzy: false }, [{ id: 'a', title: 'A' }]);
        expect(result.groups[0].rows[0].mangaId).toBe('2'); expect(result.revisions.a).toBe(2);
    });
});
