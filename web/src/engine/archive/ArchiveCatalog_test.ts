import { describe, expect, it } from 'vitest';
import { EngineArchiveSource } from './ArchiveSource';
import type { Manga, MangaPlugin } from '../providers/MangaPlugin';

describe('Original connector catalog observations', () => {
    it('Should yield successful native page observations before a later request fails and unsubscribe cleanly', async () => {
        let listener: (entries: readonly Manga[], status?: number) => void, release: () => void, subscribed = false;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const site = { ObserveCatalogEntries(callback: typeof listener) { subscribed = true; listener = callback; return () => { subscribed = false; }; }, async FetchArchiveEntries() {
            listener([{ Identifier: 'one', Title: 'One' } as Manga], 200); await gate; throw new Error('HTTP 521');
        } } as unknown as MangaPlugin;
        const pages = new EngineArchiveSource(site).Catalog(new AbortController().signal)[Symbol.asyncIterator]();
        expect((await pages.next()).value).toMatchObject({ items: [{ id: 'one', title: 'One' }], httpStatus: 200, terminal: false });
        release(); await expect(pages.next()).rejects.toThrow('HTTP 521'); expect(subscribed).toBe(false);
    });
    it('Should retain the array fallback for connectors without page observations and never assert complete coverage', async () => {
        const site = { async FetchArchiveEntries() { return Array.from({ length: 399 }, (_, n) => ({ Identifier: String(n), Title: `Manga ${n}` })); } } as unknown as MangaPlugin;
        const frames = [];
        for await (const frame of new EngineArchiveSource(site).Catalog(new AbortController().signal)) frames.push(frame);
        expect(frames.flatMap(frame => frame.items)).toHaveLength(399); expect(frames.at(-1).terminal).toBe(true);
        expect(frames.every(frame => frame.coverage.state === 'unknown')).toBe(true);
    });
});
