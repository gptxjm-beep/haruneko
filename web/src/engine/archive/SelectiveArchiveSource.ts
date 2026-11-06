import { EngineArchiveSource, type ArchiveSource, type ArchiveChapterManifest } from './ArchiveSource';
import type { MangaPlugin, Manga } from '../providers/MangaPlugin';
import type { MangaReference, QueueScope } from '../../../../app/electron/src/archive/SelectiveQueueContract';
/** Personal manifest adapter only. All receipt/recovery/capacity/download behavior remains ArchiveManager's. */
export class SelectiveArchiveSource implements ArchiveSource {
    constructor(public readonly site: MangaPlugin, private readonly reference: MangaReference, private readonly scope: QueueScope,
        private readonly source: ArchiveSource = new EngineArchiveSource(site)) {}
    public async *Catalog(signal: AbortSignal) {
        signal.throwIfAborted();
        yield { items: [{ id: this.reference.mangaId, title: this.reference.title }], terminal: true as const,
            coverage: { state: 'unknown' as const, evidence: 'Explicit personal selection; not a complete site index' } };
    }
    public async Chapters(manga: Manga, signal: AbortSignal): Promise<ArchiveChapterManifest> {
        const manifest = await this.source.Chapters(manga, signal);
        if (manifest.order === 'unknown' || !manifest.orderEvidence.trim()) return { ...manifest, order: 'unknown' };
        if (this.scope.mode !== 'range') return manifest;
        if (this.scope.to > manifest.chapters.length) throw new Error('Unsupported chapter range: discovered list is shorter than the requested range');
        const ordered = manifest.order === 'descending' ? [...manifest.chapters].reverse() : manifest.chapters;
        return { chapters: ordered.slice(this.scope.from - 1, this.scope.to), order: 'ascending', orderEvidence: `${manifest.orderEvidence}; explicit oldest-first range ${this.scope.from}-${this.scope.to}`,
            coverage: { state: 'unknown', evidence: 'Selected ordinal range of observed chapters; not complete source coverage' } };
    }
}
