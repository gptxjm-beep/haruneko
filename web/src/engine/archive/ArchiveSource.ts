import type { MangaPlugin, Manga, Chapter } from '../providers/MangaPlugin';
import { Tags } from '../Tags';
import type { ArchiveEvidence, ArchiveWorkChapter } from '../../../../app/electron/src/archive/ArchiveCoordinatorProtocol';

export interface ArchiveCatalogPage {
    items: readonly { id: string; title: string }[];
    terminal: boolean;
    coverage: ArchiveEvidence;
}
export interface ArchiveChapterManifest {
    chapters: readonly ArchiveWorkChapter[];
    order: 'ascending' | 'descending' | 'unknown';
    orderEvidence: string;
    coverage: ArchiveEvidence;
}
/** Optional streaming capability supplied by connector integrations; absence never proves completeness. */
export interface ArchiveSource {
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
        await this.site.Update();
        signal.throwIfAborted();
        const entries = this.site.Entries.Value;
        if (!entries.length) yield { items: [], terminal: true, coverage: { state: 'unknown', evidence: 'Empty connector index requires review' } };
        for (let offset = 0; offset < entries.length; offset += 50) {
            signal.throwIfAborted();
            yield { items: entries.slice(offset, offset + 50).map(manga => ({ id: manga.Identifier, title: manga.Title })), terminal: offset + 50 >= entries.length,
                coverage: { state: 'unknown', evidence: 'FetchMangas returns an array without a complete-index proof' } };
        }
    }

    public async Chapters(manga: Manga, signal: AbortSignal): Promise<ArchiveChapterManifest> {
        signal.throwIfAborted();
        await manga.Update();
        signal.throwIfAborted();
        return { chapters: manga.Entries.Value.map((chapter, position) => ({ id: chapter.Identifier, title: chapter.Title, position, language: ChapterLanguage(chapter, this.site) })),
            order: 'descending', orderEvidence: 'MangaScraper.FetchChapters guarantees newest-first after connector decorators',
            coverage: { state: 'unknown', evidence: 'FetchChapters has no page-manifest completeness evidence' } };
    }
}
