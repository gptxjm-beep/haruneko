import { MangaPlugin } from '../providers/MangaPlugin';
import type { DownloadManager } from '../DownloadManager';
import { ArchiveClient } from './ArchiveClient';
import { ArchiveManager } from './ArchiveManager';
import type { ArchiveUIProgress, ArchiveUISession, ArchivePreferences } from '../../../../app/electron/src/archive/ArchiveUIContract';

/** Renderer-lifetime owner. Views only observe; mounting/unmounting never starts or cancels work. */
export class ArchiveUIController {
    private readonly active = new Map<string, ArchiveManager>();
    private readonly starting = new Map<string, Promise<void>>();
    constructor(public readonly Client: ArchiveClient, private readonly sites: () => readonly unknown[], private readonly downloads: DownloadManager) {}

    public Supported(site: unknown): site is MangaPlugin { return site instanceof MangaPlugin && this.sites().includes(site); }
    public async Preferences(): Promise<{ preferences: ArchivePreferences; rootLabel: string }> { return this.Client.Request({ operation: 'ui-preferences' }); }
    public async Sessions(before?: number): Promise<ArchiveUISession[]> { return this.Client.Request({ operation: 'ui-sessions', before }); }
    public async Progress(sessionId: string): Promise<ArchiveUIProgress> { return this.Client.Request({ operation: 'ui-progress', sessionId }); }
    public async Create(site: unknown, preferences: ArchivePreferences, confirmed: boolean): Promise<string> {
        if (!this.Supported(site)) throw new Error('Select a supported manga website. Bookmarks and other media types cannot be archived.');
        if (confirmed !== true) throw new Error('Confirm the limited archive trial before creating the session.');
        return this.Client.Request({ operation: 'ui-create-session', siteId: site.Identifier, siteName: site.Title, preferences, confirmed });
    }
    public Start(sessionId: string): Promise<void> {
        if (this.active.has(sessionId)) return Promise.resolve();
        if (this.starting.has(sessionId)) return this.starting.get(sessionId)!;
        const operation = this.Open(sessionId).finally(() => this.starting.delete(sessionId));
        this.starting.set(sessionId, operation);
        return operation;
    }
    private async Open(sessionId: string): Promise<void> {
        const session = await this.Progress(sessionId);
        if (session.snapshot.state === 'cancelled') throw new Error('Cancelled sessions cannot resume.');
        const site = this.sites().find(site => site instanceof MangaPlugin && site.Identifier === session.siteId);
        if (!this.Supported(site)) throw new Error('The original manga connector is unavailable. The session has been preserved.');
        const manager = new ArchiveManager(site, this.downloads, this.Client, sessionId, session.snapshot.policy);
        this.active.set(sessionId, manager);
        void manager.Start().catch(async () => {
            await this.Client.Request({ operation: 'archive-run-state', sessionId, state: 'failed', reason: 'Archive execution failed; progress remains saved. Inspect errors before retrying.' });
        }).catch(() => { /* SQLite may be unavailable; startup recovery marks an unclosed run interrupted. */ })
            .finally(() => this.active.delete(sessionId));
    }
    public async Pause(sessionId: string): Promise<void> {
        await this.starting.get(sessionId);
        await this.active.get(sessionId)?.Pause();
    }
    public async Cancel(sessionId: string): Promise<void> {
        await this.starting.get(sessionId);
        const manager = this.active.get(sessionId);
        if (manager) await manager.Cancel();
        else await this.Client.Request({ operation: 'archive-run-state', sessionId, state: 'cancelled', reason: 'Cancelled by user; files preserved' });
    }
    public IsRunning(sessionId: string): boolean { return this.active.has(sessionId) || this.starting.has(sessionId); }
}

let controller: ArchiveUIController | undefined;
export function GetArchiveUIController(): ArchiveUIController {
    if (!globalThis.ipcRenderer?.invoke) throw new Error('Smart Site Archiver requires the Electron desktop client.');
    return controller ??= new ArchiveUIController(new ArchiveClient(), () => globalThis.HakuNeko.PluginController.WebsitePlugins, globalThis.HakuNeko.DownloadManager);
}
/** Safe public text for UI exceptions; raw connector/native diagnostics are never rendered. */
export function ArchiveUIError(error: unknown): string {
    const text = error instanceof Error ? error.message : 'Archive operation failed';
    return text.slice(0, 512).replace(/https?:\/\/\S+/gi, '[source]').replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*/g, '[path]')
        .replace(/\b(authorization|cookie|token|password|secret)\s*[:=].*/gi, '$1=[redacted]');
}
