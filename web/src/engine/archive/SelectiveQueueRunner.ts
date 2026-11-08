import { ArchiveManager } from './ArchiveManager';
import { ArchiveClient } from './ArchiveClient';
import { ArchiveUIError } from './ArchiveUIController';
import { MangaPlugin } from '../providers/MangaPlugin';
import { SelectiveArchiveSource } from './SelectiveArchiveSource';
import { DownloadMangaDetails } from './MangaDetails';
import { StorageControllerBrowser } from '../StorageControllerBrowser';
import { Store } from '../StorageController';
import type { DownloadManager } from '../DownloadManager';
import type { ArchivePreferences } from '../../../../app/electron/src/archive/ArchiveUIContract';
import type { QueueManga, QueueSnapshot } from '../../../../app/electron/src/archive/SelectiveQueueContract';

async function DetailsEnabled(): Promise<boolean> {
    try { return typeof navigator !== 'undefined' && !!navigator.storage && await new StorageControllerBrowser().LoadPersistent<boolean>(Store.Settings, 'arabic-download-manga-details') === true; }
    catch { return false; }
}

export class SelectiveQueueRunner {
    private completion?: Promise<void>;
    private active?: ArchiveManager;
    private requested?: 'Paused' | 'Cancelled';
    private optionalAbort = new AbortController();
    constructor(private readonly client: ArchiveClient, private readonly sites: () => readonly unknown[], private readonly downloads: DownloadManager,
        private readonly factory = (site: MangaPlugin, item: QueueManga, preferences: ArchivePreferences) => new ArchiveManager(site, downloads, client, item.sessionId!, preferences.policy,
            { source: new SelectiveArchiveSource(site, item, item.scope, undefined, available => client.Request<void>({ operation: 'queue-observation', seq: item.seq, available })) }),
        private readonly details = { enabled: DetailsEnabled, download: DownloadMangaDetails }) {}
    public get Running(): boolean { return !!this.completion; }
    public async Start(preferences: ArchivePreferences, confirmed: boolean): Promise<void> {
        if (this.completion) throw new Error('Queue is already running');
        // Reserve ownership before awaiting IPC, preventing double clicks from creating two loops.
        this.requested = undefined;
        this.optionalAbort = new AbortController();
        const operation = this.Run(preferences, confirmed);
        this.completion = operation;
        void operation.catch(() => {}).finally(() => { if (this.completion === operation) this.completion = undefined; });
        await operation;
    }
    public async Pause(): Promise<void> { this.requested = 'Paused'; this.optionalAbort.abort(); await this.active?.Pause(); await this.completion; }
    public async Cancel(): Promise<void> {
        this.requested = 'Cancelled'; this.optionalAbort.abort(); await this.active?.Cancel();
        if (this.completion) await this.completion;
        else await this.client.Request({ operation: 'queue-stop', state: 'Cancelled', reason: 'Cancelled by user; files and pending references retained' });
    }
    private async Run(preferences: ArchivePreferences, confirmed: boolean): Promise<void> {
        // Main freezes a durable membership (or resumes its existing one); this loop never grows that set.
        await this.client.Request({ operation: 'queue-open', preferences, confirmed });
        const optionalDetails = await this.details.enabled().catch(() => false);
        try {
            while (!this.requested) {
                const item = await this.client.Request<QueueManga | null>({ operation: 'queue-next' });
                if (!item) break;
                if (this.requested) { await this.client.Request({ operation: 'queue-stop', state: this.requested, reason: 'Stopped before starting the next task' }); break; }
                const site = this.sites().find(site => site instanceof MangaPlugin && site.Identifier === item.siteId);
                if (!(site instanceof MangaPlugin)) { await this.client.Request({ operation: 'queue-result', seq: item.seq, reason: 'Original manga connector is unavailable; saved reference retained' }); continue; }
                this.active = this.factory(site, item, preferences);
                try { await this.active.Start(); }
                catch(error) {
                    await this.client.Request({ operation: 'archive-run-state', sessionId: item.sessionId!, state: 'failed', reason: ArchiveUIError(error) });
                } finally { this.active = undefined; }
                if (optionalDetails && !this.requested) {
                    try { await this.details.download(site, item, this.client, this.optionalAbort.signal); }
                    catch { await this.client.Request({ operation: 'queue-details-unavailable', seq: item.seq }).catch(() => {}); }
                }
                await this.client.Request({ operation: 'queue-result', seq: item.seq });
                const summary = await this.client.Request<QueueSnapshot>({ operation: 'queue-summary' });
                if (summary.state !== 'Running') break;
            }
            if (this.requested) await this.client.Request({ operation: 'queue-stop', state: this.requested, reason: `User requested ${this.requested}; files and cumulative budgets preserved` });
        } catch(error) {
            // Failure to persist a checkpoint stops execution; startup recovery handles an unavailable SQLite connection.
            await this.client.Request({ operation: 'queue-stop', state: this.requested ?? 'Failed', reason: ArchiveUIError(error) }).catch(() => {});
            throw error;
        }
    }
}
let runner: SelectiveQueueRunner;
export function GetSelectiveQueueRunner(): SelectiveQueueRunner {
    return runner ??= new SelectiveQueueRunner(new ArchiveClient(), () => HakuNeko.PluginController.WebsitePlugins, HakuNeko.DownloadManager);
}
