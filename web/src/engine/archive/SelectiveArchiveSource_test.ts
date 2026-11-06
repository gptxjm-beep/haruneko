import { describe, expect, it } from 'vitest';
import { SelectiveArchiveSource } from './SelectiveArchiveSource';
import type { ArchiveSource, ArchiveChapterManifest } from './ArchiveSource';
import type { MangaPlugin, Manga } from '../providers/MangaPlugin';
const site = {} as MangaPlugin, manga = {} as Manga;
const ref = { siteId: 'site', mangaId: 'manga', title: 'Original', siteName: 'Site' };
function Source(order: 'ascending' | 'descending' | 'unknown'): ArchiveSource {
    return { site, Catalog: async function* () { throw new Error('No site indexing'); }, Chapters: async (): Promise<ArchiveChapterManifest> => ({
        chapters: ['special', '1.5', '0'].map((id, position) => ({ id, title: id, position, language: 'ar' })), order, orderEvidence: 'Fixture source contract', coverage: { state: 'unknown', evidence: 'Fixture' } }) };
}
describe('Selective chapter manifest adapter', () => {
    it('Should slice a trusted oldest-first range without guessing numeric or special titles', async () => {
        const source = new SelectiveArchiveSource(site, ref, { mode: 'range', from: 1, to: 2 }, Source('descending'));
        const manifest = await source.Chapters(manga, new AbortController().signal);
        expect(manifest.chapters.map(chapter => chapter.id)).toEqual(['0', '1.5']); expect(manifest.order).toBe('ascending'); expect(manifest.coverage.state).toBe('unknown');
    });
    it('Should retain unknown ordering for review without applying a guessed range', async () => {
        const manifest = await new SelectiveArchiveSource(site, ref, { mode: 'range', from: 1, to: 1 }, Source('unknown')).Chapters(manga, new AbortController().signal);
        expect(manifest.order).toBe('unknown'); expect(manifest.chapters).toHaveLength(3);
    });
    it('Should reject an unavailable range and honor cancellation without enumerating the site', async () => {
        const source = new SelectiveArchiveSource(site, ref, { mode: 'range', from: 1, to: 4 }, Source('ascending'));
        await expect(source.Chapters(manga, new AbortController().signal)).rejects.toThrow('Unsupported');
        const cancellation = new AbortController(); cancellation.abort();
        await expect(source.Catalog(cancellation.signal).next()).rejects.toThrow();
    });
});
