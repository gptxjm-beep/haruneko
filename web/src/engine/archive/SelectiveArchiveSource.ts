import { EngineArchiveSource, type ArchiveSource, type ArchiveChapterManifest } from './ArchiveSource';
import type { MangaPlugin, Manga } from '../providers/MangaPlugin';
import type { MangaReference, QueueScope } from '../../../../app/electron/src/archive/SelectiveQueueContract';
/** Personal manifest adapter only. All receipt/recovery/capacity/download behavior remains ArchiveManager's. */
export class SelectiveArchiveSource implements ArchiveSource {
    public readonly executionOrderConfidence = 'user-confirmed' as const;
    constructor(public readonly site: MangaPlugin, private readonly reference: MangaReference, private readonly scope: QueueScope,
        private readonly source: ArchiveSource = new EngineArchiveSource(site)) {}
    public async *Catalog(signal: AbortSignal) {
        signal.throwIfAborted();
        yield { items: [{ id: this.reference.mangaId, title: this.reference.title }], terminal: true as const,
            coverage: { state: 'unknown' as const, evidence: 'Explicit personal selection; not a complete site index' } };
    }
    public async Chapters(manga: Manga, signal: AbortSignal): Promise<ArchiveChapterManifest> {
        const manifest = await this.source.Chapters(manga, signal);
        if (this.scope.order) {
            const direction = manifest.order === 'unknown' ? this.scope.direction : manifest.order;
            if (this.scope.mode === 'range' && !direction) throw new Error('Review required: numeric range needs proven or explicitly confirmed chronology');
            if (this.scope.order !== 'source' && !direction) throw new Error('Review required: confirm source direction before chronological ordering');
            let chapters = [...manifest.chapters];
            if (this.scope.mode === 'range') {
                const chronological = direction === 'descending' ? [...chapters].reverse() : chapters;
                if (this.scope.to > chapters.length) throw new Error('Unsupported chapter range');
                const ids = new Set(chronological.slice(this.scope.from - 1, this.scope.to).map(chapter => chapter.id));
                chapters = chapters.filter(chapter => ids.has(chapter.id));
            }
            if (this.scope.mode === 'selected') {
                const ids = new Set(this.scope.ids);
                const available = new Set(chapters.map(chapter => chapter.id));
                if ([...ids].some(id => !available.has(id))) throw new Error('Review required: selected chapter identity absent from source');
                chapters = chapters.filter(chapter => ids.has(chapter.id));
            }
            if (this.scope.order === 'first-last' && direction === 'descending' || this.scope.order === 'last-first' && direction === 'ascending') chapters.reverse();
            return { ...manifest, chapters, order: 'ascending', sequenceOnly: true,
                orderEvidence: `Personal execution sequence ${this.scope.order}; ${direction ? `direction ${direction}${manifest.order === 'unknown' ? ' explicitly confirmed by user' : ' from connector evidence'}` : 'chronology unproven; source order explicitly accepted'}; ${manifest.orderEvidence}` };
        }
        if (manifest.order === 'unknown' || !manifest.orderEvidence.trim()) return { ...manifest, order: 'unknown' };
        if (this.scope.mode !== 'range') return manifest;
        if (this.scope.to > manifest.chapters.length) throw new Error('Unsupported chapter range: discovered list is shorter than the requested range');
        const ordered = manifest.order === 'descending' ? [...manifest.chapters].reverse() : manifest.chapters;
        return { chapters: ordered.slice(this.scope.from - 1, this.scope.to), order: 'ascending', orderEvidence: `${manifest.orderEvidence}; explicit oldest-first range ${this.scope.from}-${this.scope.to}`,
            coverage: { state: 'unknown', evidence: 'Selected ordinal range of observed chapters; not complete source coverage' } };
    }
}
