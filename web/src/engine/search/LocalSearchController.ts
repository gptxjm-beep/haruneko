import { MediaDatabaseBlockedError } from '../catalog/MediaDatabase';
import { Observable } from '../Observable';
import { StorageControllerBrowser } from '../StorageControllerBrowser';
import { Store, type StorageController } from '../StorageController';
import { MangaPlugin } from '../providers/MangaPlugin';
import { Tags } from '../Tags';
import { SearchWorkerClient } from './SearchWorkerClient';
import { EmptySearchPreference, SearchPreferenceKey, ValidSearchPreference, type SearchPreference, type SearchResult, type SearchSite } from './LocalSearch';

export interface SearchView { preference: SearchPreference; status: 'idle' | 'searching' | 'ready' | 'error'; result: SearchResult | null; error: string; }
export function ArabicSearchSites(): SearchSite[] {
    return HakuNeko.PluginController.WebsitePlugins.filter(site => site instanceof MangaPlugin && site.Tags.Value.some(tag => tag.Category === Tags.Language.Arabic.Category && tag.Title === Tags.Language.Arabic.Title))
        .map(site => ({ id: site.Identifier, title: site.Title }));
}
/** Renderer-lifetime owner. Remounting a result view neither fetches websites nor loses its query/page. */
export class LocalSearchController {
    public readonly State = new Observable<SearchView>({ preference: { ...EmptySearchPreference }, status: 'idle', result: null, error: '' });
    private initialized: Promise<void> | undefined;
    private saves = Promise.resolve();
    private persistenceReady = false;
    private edits: Partial<SearchPreference> = {};
    private timer: ReturnType<typeof setTimeout> | undefined;
    private serial = 0;
    private channel: BroadcastChannel | undefined;
    constructor(private readonly storage: StorageController, public readonly Client: SearchWorkerClient, public readonly Sites: () => SearchSite[], private readonly preferenceKey = SearchPreferenceKey, private readonly browse = false) {
        if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
            this.channel = new BroadcastChannel('haruneko-catalog');
            this.channel.onmessage = () => { if (this.State.Value.preference.query.trim() || this.browse && this.State.Value.preference.siteId) this.Query({}, 100); };
        }
    }
    public Initialize(): Promise<void> {
        return this.initialized ??= this.storage.LoadPersistent<SearchPreference>(Store.Settings, this.preferenceKey).then(value => {
            this.persistenceReady = true;
            this.State.Value = { ...this.State.Value, preference: ValidSearchPreference({ ...value, ...this.edits }) };
            if (Object.keys(this.edits).length) this.Save();
        }).catch(error => { this.initialized = undefined; this.State.Value = { ...this.State.Value, status: 'error', error: error instanceof MediaDatabaseBlockedError ? 'Catalog database upgrade is blocked by an older window. Close it and retry. Data has not been deleted.' : 'Cannot load local search preferences. No site requests were made.' }; });
    }
    private Save(): void {
        if (!this.persistenceReady) return;
        const preference = { ...this.State.Value.preference };
        this.saves = this.saves.catch(() => {}).then(() => this.storage.SavePersistent(preference, Store.Settings, this.preferenceKey));
        void this.saves.catch(() => { this.State.Value = { ...this.State.Value, error: 'Cannot save the search position. Local results were not deleted.' }; });
    }
    public async Flush(): Promise<void> { await this.saves; }
    public SetActive(active: boolean): void { this.edits.active = active; this.State.Value = { ...this.State.Value, preference: { ...this.State.Value.preference, active } }; this.Save(); }
    public SetScroll(scroll: number): void { this.edits.scroll = scroll; this.State.Value = { ...this.State.Value, preference: { ...this.State.Value.preference, scroll } }; this.Save(); }
    public Query(change: Partial<SearchPreference>, delay = 250): void {
        Object.assign(this.edits, change);
        clearTimeout(this.timer); this.Client.Cancel(); const serial = ++this.serial;
        const preference = ValidSearchPreference({ ...this.State.Value.preference, ...change });
        this.State.Value = { preference, status: preference.query.trim() || this.browse && preference.siteId ? 'searching' : 'idle', result: null, error: '' }; this.Save();
        if (!preference.query.trim() && !(this.browse && preference.siteId)) return;
        this.timer = setTimeout(() => { void this.Run(serial); }, delay);
    }
    private async Run(serial: number): Promise<void> {
        try {
            const preference = this.State.Value.preference;
            const result = await this.Client.Search({ ...preference, browse: this.browse }, this.Sites());
            if (serial !== this.serial) return;
            const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
            if (preference.page > pages) { this.Query({ page: pages, scroll: 0 }, 0); return; }
            this.State.Value = { ...this.State.Value, status: 'ready', result, error: '' };
        } catch(error) {
            if (serial !== this.serial || (error as Error)?.name === 'AbortError') return;
            this.State.Value = { ...this.State.Value, status: 'error', result: null, error: (error as Error)?.message === 'blocked'
                ? 'Catalog database upgrade is blocked by an older window. Close it and retry. Data has not been deleted.' : 'Cannot read local catalogs, or their revisions changed. Retry the search without updating sites.' };
        }
    }
    public Close(): void { clearTimeout(this.timer); this.serial++; this.Client.Close(); this.channel?.close(); }
}
let controller: LocalSearchController | undefined;
export function GetLocalSearchController(): LocalSearchController { return controller ??= new LocalSearchController(new StorageControllerBrowser(), new SearchWorkerClient(), ArabicSearchSites); }

let explorer: LocalSearchController;
export function GetExplorerSearchController(): LocalSearchController { return explorer ??= new LocalSearchController(new StorageControllerBrowser(), new SearchWorkerClient(), ArabicSearchSites, 'frontend.classic.arabic-explorer', true); }
