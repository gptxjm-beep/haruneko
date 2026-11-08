import type { MangaPlugin, Manga, Chapter } from '../providers/MangaPlugin';
import { Tags } from '../Tags';
import type { ArchiveEvidence, ArchiveWorkChapter } from '../../../../app/electron/src/archive/ArchiveCoordinatorProtocol';

export interface ArchiveCatalogPage {
    httpStatus?: number;
    items: readonly { id: string; title: string }[];
    terminal: boolean;
    coverage: ArchiveEvidence;
}
export interface ArchiveChapterManifest {
    sequenceOnly?: boolean;
    chapters: readonly ArchiveWorkChapter[];
    order: 'ascending' | 'descending' | 'unknown';
    orderEvidence: string;
    coverage: ArchiveEvidence;
}
/** Optional streaming capability supplied by connector integrations; absence never proves completeness. */
export interface ArchiveSource {
    readonly executionOrderConfidence?: 'user-confirmed';
    readonly site: MangaPlugin;
    Catalog(signal: AbortSignal): AsyncIterable<ArchiveCatalogPage>;
    Chapters(manga: Manga, signal: AbortSignal): Promise<ArchiveChapterManifest>;
}

const languageCodes: Record<string, string> = { Arabic: 'ar', Chinese: 'zh', English: 'en', French: 'fr', German: 'de', Indonesian: 'id', Italian: 'it',
    Japanese: 'ja', Korean: 'ko', Polish: 'pl', Portuguese: 'pt', Russian: 'ru', Spanish: 'es', Thai: 'th', Turkish: 'tr', Vietnamese: 'vi' };

function ChapterLanguage(chapter: Chapter, site: MangaPlugin): string | null {
    const read = (tags: typeof chapter.Tags.Value) => Object.entries(languageCodes).filter(([name]) => tags.some(tag => tag.Title === Tags.Language[name].Title)).map(([, code]) => code);
    const own = read(chapter.Tags.Value);
    if (own.length === 1) return own[0];
    if (own.length || [...chapter.Tags.Value, ...site.Tags.Value].some(tag => tag.Title === Tags.Language.Multilingual.Title)) return null;
    const inherited = read(site.Tags.Value);
    return inherited.length === 1 ? inherited[0] : null;
}

/** Uses engine objects directly, including connector decorators, never UI sorting or read markers. */
export class EngineArchiveSource implements ArchiveSource {
    constructor(public readonly site: MangaPlugin) {}

    public async *Catalog(signal: AbortSignal): AsyncIterable<ArchiveCatalogPage> {
        signal.throwIfAborted();
        const pages: { entries: readonly Manga[]; status?: number }[] = [];
        let wake = () => {}, finished = false, failure: unknown, observed = false;
        const owned = new AbortController();
        const combined = AbortSignal.any([signal, owned.signal]);
        const unsubscribe = this.site.ObserveCatalogEntries?.((entries, status) => { observed = true; pages.push({ entries, status }); wake(); });
        let entries: readonly Manga[] = [];
        const fetching = this.site.FetchArchiveEntries(combined).then(value => { entries = value; }, error => { failure = error; }).finally(() => { finished = true; wake(); });
        try {
            while (!finished || pages.length) {
                if (!pages.length) { await new Promise<void>(resolve => { wake = resolve; if (finished || pages.length) resolve(); }); continue; }
                const page = pages.shift()!;
                for (let offset = 0; offset < page.entries.length; offset += 50) {
                    combined.throwIfAborted();
                    yield { items: page.entries.slice(offset, offset + 50).map(manga => ({ id: manga.Identifier, title: manga.Title })), httpStatus: page.status, terminal: false, coverage: { state: 'unknown', evidence: 'Observed connector page; source completeness unproven' } };
                }
            }
            if (failure) throw failure;
            if (observed) { yield { items: [], terminal: true, coverage: { state: 'unknown', evidence: 'Connector enumeration settled; completeness unproven' } }; return; }
            signal.throwIfAborted();
            if (!entries.length) yield { items: [], terminal: true, coverage: { state: 'unknown', evidence: 'Empty connector index requires review' } };
            for (let offset = 0; offset < entries.length; offset += 50) {
                signal.throwIfAborted();
                yield { items: entries.slice(offset, offset + 50).map(manga => ({ id: manga.Identifier, title: manga.Title })), terminal: offset + 50 >= entries.length,
                    coverage: { state: 'unknown', evidence: 'FetchMangas returns an array without a complete-index proof' } };
            }
        } finally { unsubscribe?.(); owned.abort(); await fetching; }
    }

    public async Chapters(manga: Manga, signal: AbortSignal): Promise<ArchiveChapterManifest> {
        signal.throwIfAborted();
        await manga.Update();
        signal.throwIfAborted();
        const ordering = manga.ArchiveChapterOrder;
        return { chapters: manga.Entries.Value.map((chapter, position) => ({ id: chapter.Identifier, title: chapter.Title, position, language: ChapterLanguage(chapter, this.site) })),
            order: ['ascending', 'descending'].includes(ordering.order) && ordering.evidence?.trim() ? ordering.order : 'unknown',
            orderEvidence: ordering.evidence?.trim() || 'Connector chapter direction has not been verified',
            coverage: { state: 'unknown', evidence: 'FetchChapters has no page-manifest completeness evidence' } };
    }
}
