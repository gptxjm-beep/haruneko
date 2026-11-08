import { CreateRemoteBrowserWindow, type IRemoteBrowserWindow } from '../platform/RemoteBrowserWindow';
import { CheckAntiScrapingDetection, FetchRedirection } from '../platform/AntiScrapingDetection';
import { GetSiteIndexController } from './SiteIndexController';
let opened: IRemoteBrowserWindow | undefined;
let polling: ReturnType<typeof setInterval>;
/** Explicit user action; one separate native browser window, no catalog or CAPTCHA solver. */
export async function VerifySite(siteId: string): Promise<void> {
    if (opened) throw new Error('Close the current verification window before opening another');
    const indexer = GetSiteIndexController(), site = HakuNeko.PluginController.WebsitePlugins.find(site => site.Identifier === siteId);
    if (!site || !(await indexer.Repository.Snapshot()).job?.items.some(item => item.siteId === siteId && ['verification', 'ready'].includes(item.state))) throw new Error('No deferred verification for this source');
    const win = opened = CreateRemoteBrowserWindow(); let checking = false;
    const ready = async () => {
        if (checking || opened !== win) return; checking = true;
        try {
            if (!await win.ExecuteScript<boolean>("location.protocol === 'https:' || location.protocol === 'http:'")) return;
            if (await CheckAntiScrapingDetection(win, site.URI.href) === FetchRedirection.None) {
                clearInterval(polling); await win.Close(); win.DOMReady.Unsubscribe(ready); opened = undefined;
                await indexer.Repository.VerificationReady(siteId); await indexer.Refresh();
            }
        } catch { /* A user-closed or still-navigating window must not claim verification. */ } finally { checking = false; }
    };
    win.DOMReady.Subscribe(ready);
    polling = setInterval(() => { void ready(); }, 1500);
    try { await win.Open(new Request(site.URI), true, ''); } catch { await CloseVerification(); throw new Error('Cannot open verification window'); }
}
export async function CloseVerification(): Promise<void> { clearInterval(polling); if (opened) { const win = opened; await win.Close(); if (opened === win) opened = undefined; } }
