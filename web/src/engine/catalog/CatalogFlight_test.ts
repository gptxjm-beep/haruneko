import { describe, expect, it, vi } from 'vitest';
import { MangaPlugin } from '../providers/MangaPlugin';
describe('Shared native catalog fetch', () => {
    it('Should abort an owned catalog request without cancelling an independent manual consumer', async () => {
        let release: (value: []) => void;
        const site = Object.create(MangaPlugin.prototype) as MangaPlugin;
        const fetch = vi.fn(() => new Promise<[]>(resolve => { release = resolve; }));
        Reflect.set(site, 'scraper', { FetchMangas: fetch }); site.Initialize = async () => {};
        const stop = new AbortController();
        const manual = site.FetchArchiveEntries(), bulk = site.FetchArchiveEntries(stop.signal).then(() => 'success', () => 'aborted');
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); stop.abort();
        expect(site.CatalogSignal.aborted).toBe(false); release([]);
        expect(await manual).toEqual([]); expect(await bulk).toBe('aborted');
        const ownedStop = new AbortController(), owned = site.FetchArchiveEntries(ownedStop.signal).then(() => 'success', () => 'aborted');
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        ownedStop.abort(); expect(site.CatalogSignal.aborted).toBe(true); release([]); expect(await owned).toBe('aborted');
    });
    it('Should coalesce overlapping manual and bulk discovery but permit a later explicit refresh', async () => {
        let release: (value: []) => void;
        const pending = new Promise<[]>(resolve => { release = resolve; });
        const fetch = vi.fn(() => pending);
        const site = Object.create(MangaPlugin.prototype) as MangaPlugin;
        Reflect.set(site, 'scraper', { FetchMangas: fetch });
        site.Initialize = async () => {};
        const manual = site.FetchArchiveEntries(), bulk = site.FetchArchiveEntries();
        await Promise.resolve(); release([]);
        expect(await manual).toBe(await bulk); expect(fetch).toHaveBeenCalledOnce();
        await site.FetchArchiveEntries(); expect(fetch).toHaveBeenCalledTimes(2);
    });
});
