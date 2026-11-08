import { Key, Scope } from '../SettingsGlobal';
import type { Check, Choice, Directory, ISettings, SettingsManager } from '../SettingsManager';
import { SanitizeFileName, type StorageController, Store } from '../StorageController';
import { type Priority, TaskPool } from '../taskpool/TaskPool';
import { MediaContainer, StoreableMediaContainer, MediaItem, MediaScraper } from './MediaPlugin';
import icon from '../../img/manga.webp';
import { NotImplementedError } from '../Error';
import { TraceCatalogRequest } from '../catalog/CatalogNetwork';
import { CreateChapterExportRegistry } from '../exporters/MangaExporterRegistry';
import { Observable } from '../Observable';
import type { Tag } from '../Tags';
import { ValidateImage } from '../ValidateImage';
import { PageDiagnostic, RecordDiagnosticBlob } from '../ImageDiagnostics';
import type { StoreOptions } from '../DownloadContract';
import { MangaExportFormat } from '../exporters/MangaExporterRegistry';
import { WithOutputLock } from '../exporters/OutputLock';

const settingsKeyPrefix = 'plugin.';

export interface ArchiveChapterOrder {
    order: 'ascending' | 'descending' | 'unknown';
    evidence: string;
}

/**
 * The abstract base class that any custom manga scraper must implement.
 * This should be used for any custom manga scraper implementation that is not going to utilize the decorator pattern.
 * Custom manga scrapers that are going to utilize decorators must extend the {@link DecoratableMangaScraper} instead.
 */
export abstract class MangaScraper extends MediaScraper<MangaPlugin> {

    protected readonly imageTaskPool = new TaskPool();

    public CreatePlugin(storageController: StorageController, settingsManager: SettingsManager): MangaPlugin {
        return new MangaPlugin(storageController, settingsManager, this);
    }

    public abstract ValidateMangaURL(url: string): boolean;

    public abstract FetchManga(provider: MangaPlugin, url: string): Promise<Manga>;

    /**
     * Get the manga list for the given website {@link provider}.
     * Mangas can be in arbitrary order (usually as provided by the website), the frontend may be responsible for sorting.
     */
    public abstract FetchMangas(provider: MangaPlugin): Promise<Manga[]>;

    /**
     * Get the chapters for the given {@link manga}.
     * Connectors conventionally return newest first; archival ordering requires separate verified evidence.
     */
    public abstract FetchChapters(manga: Manga): Promise<Chapter[]>;

    /** Evidence must describe the final FetchChapters sequence, including decorators. Titles alone are not evidence. */
    public GetArchiveChapterOrder(_manga: Manga): ArchiveChapterOrder {
        return { order: 'unknown', evidence: 'Connector chapter direction has not been verified' };
    }

    /**
     * Get the pages for the given {@link chapter}.
     * Pages are guaranteed to be in the correct reading order.
     */
    public abstract FetchPages(chapter: Chapter): Promise<Page[]>;

    /**
     * Get the image for the given {@link page}.
     * The image is provided in the best possible quality as available on the website wihout any post processing (except for scrambled images).
     */
    public abstract FetchImage(page: Page, priority: Priority, signal: AbortSignal): Promise<Blob>;
}

/**
 * An empty implementation of the `MangaScraper` class.
 * Since decorators do not (yet) work well with the abstract classes, this base class can be used when applying the decorator pattern to customize manga scrapers.
 */
export class DecoratableMangaScraper extends MangaScraper {

    public ValidateMangaURL(_url: string): boolean {
        return false;
    }

    public FetchManga(_provider: MangaPlugin, _url: string): Promise<Manga> {
        throw new NotImplementedError();
    }

    public FetchMangas(_provider: MangaPlugin): Promise<Manga[]> {
        throw new NotImplementedError();
    }

    public FetchChapters(_manga: Manga): Promise<Chapter[]> {
        throw new NotImplementedError();
    }

    public FetchPages(_chapter: Chapter): Promise<Page[]> {
        throw new NotImplementedError();
    }

    public FetchImage(_page: Page, _priority: Priority, _signal: AbortSignal): Promise<Blob> {
        throw new NotImplementedError();
    }
}

export class MangaPlugin extends MediaContainer<Manga> {

    private catalogFlight?: { pending: Promise<Manga[]>; controller: AbortController; consumers: Set<object> };
    public get CatalogSignal(): AbortSignal | undefined { return this.catalogFlight?.controller.signal; }
    private readonly catalogObservers = new Set<(count: number, status?: number) => void>();
    private readonly catalogEntries = new Set<(entries: readonly Manga[], status?: number) => void>();
    private catalogHTTP?: number;
    public ObserveCatalogEntries(listener: (entries: readonly Manga[], status?: number) => void): () => void { this.catalogEntries.add(listener); return () => this.catalogEntries.delete(listener); }
    public ObserveCatalogProgress(listener: (count: number, status?: number) => void): () => void { this.catalogObservers.add(listener); return () => this.catalogObservers.delete(listener); }
    public get CatalogHTTPStatus(): number | undefined { return this.catalogHTTP; }
    public TraceCatalog(request: Request): void { TraceCatalogRequest(request, status => { this.catalogHTTP = status; for (const listener of this.catalogObservers) listener(0, status); }); }
    public ReportCatalogProgress(count: number, entries?: readonly Manga[]): void {
        if (count > 0) { for (const listener of this.catalogObservers) listener(count); if (entries) for (const listener of this.catalogEntries) listener(entries, this.catalogHTTP); }
    }
    private FetchCatalog(signal?: AbortSignal): Promise<Manga[]> {
        signal?.throwIfAborted();
        if (!this.catalogFlight) {
            this.catalogHTTP = undefined;
            const pending = Promise.resolve().then(() => this.scraper.FetchMangas(this));
            const flight = this.catalogFlight = { pending, controller: new AbortController(), consumers: new Set<object>() };
            void pending.finally(() => { if (this.catalogFlight === flight) this.catalogFlight = undefined; }).catch(() => {});
        }
        const flight = this.catalogFlight, consumer = {};
        flight.consumers.add(consumer);
        const abort = () => { flight.consumers.delete(consumer); if (!flight.consumers.size) flight.controller.abort(signal?.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        // Keep ownership until the physical chain settles, including non-cooperative legacy transports.
        return flight.pending.then(entries => { signal?.throwIfAborted(); return entries; }).finally(() => { signal?.removeEventListener('abort', abort); flight.consumers.delete(consumer); });
    }

    private readonly _settings: ISettings;

    public constructor(private readonly storageController: StorageController, private readonly settingsManager: SettingsManager, private readonly scraper: MangaScraper) {
        super(scraper.Identifier, scraper.Title);
        this._settings = this.settingsManager.OpenScope(settingsKeyPrefix + this.Identifier);
        this.tags.Value = this.scraper.Tags;
        this.Prepare();
    }

    private async Prepare() {
        await this._settings.Initialize(...this.scraper.Settings);
        await this.RefreshMediaListCache();
    }

    private mediaListEpoch = 0;
    private loadedMediaListEpoch = -1;
    public InvalidateMediaListCache(): void { this.mediaListEpoch++; }
    /** Reload only a published local catalog. Never calls a connector or discards read/favorite state. */
    public async RefreshMediaListCache(): Promise<void> {
        if (this.loadedMediaListEpoch === this.mediaListEpoch) return;
        const epoch = this.mediaListEpoch;
        const saved = await this.storageController.LoadPersistent<{ id: string; title: string }[]>(Store.MediaLists, this.Identifier) || [];
        const entries: Manga[] = [];
        for (let start = 0; start < saved.length; start += 500) {
            entries.push(...saved.slice(start, start + 500).map(item => this.CreateEntry(item.id, item.title)));
            if (start + 500 < saved.length) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (epoch === this.mediaListEpoch) { this.entries.Value = entries; this.loadedMediaListEpoch = epoch; }
    }

    public override get Settings(): ISettings {
        return this._settings;
    }

    public override get Icon(): string {
        return this.scraper.Icon;
    }

    public get URI(): URL {
        return this.scraper.URI;
    }

    public async Initialize(owner?: AbortSignal): Promise<void> {
        await this.scraper.Initialize(owner);
        return super.Initialize();
    }

    public override CreateEntry(identifier: string, title: string): Manga {
        return new Manga(this.scraper, this, identifier, title);
    }

    public override async TryGetEntry(url: string): Promise<Manga> {
        if(this.scraper.ValidateMangaURL(url)) {
            await this.Initialize();
            const manga = await this.scraper.FetchManga(this, url);
            return this.Entries.Value.find((entry) => entry.IsSameAs(manga)) ?? manga;
        }
    }

    protected async PerformUpdate(): Promise<Manga[]> {
        const entries = await this.FetchCatalog();
        const mangas = entries.map(entry => {
            return { id: entry.Identifier, title: entry.Title };
        });
        await this.storageController.SavePersistent(mangas, Store.MediaLists, this.Identifier);
        return entries;
    }

    /** Archive discovery uses the engine scraper without writing an unbudgeted UI cache into IndexedDB. */
    public async FetchArchiveEntries(signal?: AbortSignal): Promise<Manga[]> {
        await this.Initialize(signal);
        return this.FetchCatalog(signal);
    }
}

export class Manga extends MediaContainer<Chapter> {

    constructor(private readonly scraper: MangaScraper, parent: MangaPlugin, identifier: string, title: string, ...tags: Tag[]) {
        super(identifier, title, parent);
        this.tags.Value = tags;
    }

    public override get Icon() {
        return icon;
    }

    public override CreateEntry(identifier: string, title: string): Chapter {
        return new Chapter(this.scraper, this, identifier, title);
    }

    public get ArchiveChapterOrder(): ArchiveChapterOrder {
        return this.scraper.GetArchiveChapterOrder?.(this) ?? { order: 'unknown', evidence: 'Connector chapter direction has not been verified' };
    }

    protected PerformUpdate(): Promise<Chapter[]> {
        return this.scraper.FetchChapters(this);
    }
}

export class Chapter extends StoreableMediaContainer<Page> {

    private readonly isStored = new Observable<boolean, Chapter>(false);

    constructor(private readonly scraper: MangaScraper, parent: Manga, identifier: string, title: string, ...tags: Tag[]) {
        super(identifier, title, parent);
        this.tags.Value = tags;
    }

    protected PerformUpdate(): Promise<Page[]> {
        return this.scraper.FetchPages(this);
    }

    public get IsStored() {
        return this.isStored;
    }

    public async Store(resources: Map<number, string>, options: StoreOptions = {}): Promise<void> {
        // TODO: Inject settings manager and global scope identifier?
        const native = options.archiveTarget;
        const settings = native ? undefined : HakuNeko.SettingsManager.OpenScope(Scope);
        const directory = native || options.directory ? undefined : settings.Get<Directory>(Key.MediaDirectory);
        // Snapshot scalar settings before any asynchronous permission or filesystem operation.
        const format = options.format ?? native?.format ?? settings.Get<Choice>(Key.MangaExportFormat).Value;
        const websiteSubDirectory = options.useWebsiteSubDirectory ?? native?.useWebsiteSubDirectory ?? settings.Get<Check>(Key.UseWebsiteSubDirectory).Value;
        let output = native ? undefined : options.directory ?? directory.Value;
        const root = output;
        if (directory) await directory.EnsureAccess();
        else if (!native && await output.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Download directory write permission is required');
        options.context?.signal.throwIfAborted();
        const segments: string[] = [];
        if(websiteSubDirectory && this.Parent?.Parent) {
            const website = SanitizeFileName(this.Parent?.Parent?.Title);
            segments.push(website);
            if (!native) output = await output.getDirectoryHandle(website, { create: true });
        }
        if(this.Parent) {
            const manga = SanitizeFileName(this.Parent?.Title);
            segments.push(manga);
            if (!native) output = await output.getDirectoryHandle(manga, { create: true });
        }

        // TODO: Find more appropriate way to inject the storage dependency
        const registry = CreateChapterExportRegistry(this.Parent?.Parent['storageController']);
        const exporter = registry[format];
        if (!exporter) throw new Error(`Unsupported manga export format: ${format}`);
        const context = options.context && {
            ...options.context,
            writing: (path: string) => options.context.writing([...segments, path].join('/')),
            written: file => options.context.written({ ...file, path: native ? file.path : [...segments, file.path].join('/') }),
            write: native ? (path: string, data: Blob, signal: AbortSignal) => native.write([...segments, path].join('/'), data, signal) : undefined,
        };
        const exportChapter = async () => {
            await context?.begin(format === MangaExportFormat.RAWs ? resources.size : 1, { directory: root, rootId: native?.rootId, format });
            try {
                await exporter.Export(resources, output, this.Title, this.Parent?.Title, context);
            } finally {
                await context?.verify?.();
            }
        };
        if (native) await exportChapter();
        else await WithOutputLock(output, context?.signal, exportChapter);
    }
}

type Parameters = {
    readonly Referer?: string;
}

export class Page<T extends JSONObject = JSONObject> extends MediaItem {

    public constructor(
        private readonly scraper: MangaScraper,
        parent: Chapter,
        public readonly Link: URL,
        public readonly Parameters?: T & Parameters) {
        super(parent);
    }

    public CreateDiagnosticCopy(): Page<T> { return new Page(this.scraper, this.Parent as Chapter, this.Link, this.Parameters); }

    public async Fetch(priority: Priority, signal: AbortSignal): Promise<Blob> {
        const report = PageDiagnostic(this);
        const blob = await this.scraper.FetchImage(this, priority, signal);
        if (report) await RecordDiagnosticBlob(report, blob);
        return ValidateImage(blob, signal, priority, report ? (width, height) => { report.width = width; report.height = height; } : undefined);
    }
}
