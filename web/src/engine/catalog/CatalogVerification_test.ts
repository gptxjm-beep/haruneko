import { describe, expect, it, vi } from 'vitest';
import { FetchManagedCatalogWindow, OwnCatalogWindows, BindCatalogWindow, CatalogWindowContext } from './CatalogVerification';
import { Observable } from '../Observable';
import { FetchRedirection } from '../platform/AntiScrapingDetection';
import type { IRemoteBrowserWindow } from '../platform/RemoteBrowserWindow';
function fixture() {
    const ready = new Observable<void>(undefined);
    const win = { DOMReady: ready, Open: vi.fn().mockResolvedValue(undefined), Close: vi.fn().mockResolvedValue(undefined), Show: vi.fn().mockResolvedValue(undefined), ExecuteScript: vi.fn(async (script: string) => script.includes('location.protocol') ? true : 'content') } as unknown as IRemoteBrowserWindow;
    const context = { signal: new AbortController().signal, required: vi.fn(), blocked: vi.fn() };
    return { ready, win, context };
}
describe('Catalog-owned human verification manual waiting and window lifetime', () => {
    it('Should never capture an independent manual request merely because it shares the catalog origin', () => {
        const owner = new AbortController(), release = OwnCatalogWindows('https://fixture.invalid', owner.signal);
        try {
            const manual = new Request('https://fixture.invalid'), managed = BindCatalogWindow(new Request('https://fixture.invalid'), owner.signal);
            expect(CatalogWindowContext(manual)).toBeUndefined(); expect(CatalogWindowContext(managed)?.signal).toBe(owner.signal);
        } finally { release(); }
    });
    it('Should wait beyond 60 seconds and the ordinary request deadline until manual verification clears', async () => {
        vi.useFakeTimers(); try {
            const f = fixture(); let cleared = false, settled = false;
            const running = FetchManagedCatalogWindow(f.win, new Request('https://fixture.invalid'), 'script', '', 0, 180000, f.context, async () => cleared ? FetchRedirection.None : FetchRedirection.Interactive);
            void running.then(() => { settled = true; }, () => { settled = true; });
            void f.ready.Dispatch(); await vi.advanceTimersByTimeAsync(240000);
            expect(f.win.Close).not.toHaveBeenCalled(); expect(settled).toBe(false);
            cleared = true; void f.ready.Dispatch(); await vi.advanceTimersByTimeAsync(1);
            expect(await running).toBe('content'); expect(f.context.required).toHaveBeenCalledOnce();
        } finally { vi.useRealTimers(); }
    });
    it('Should retain ownership on cancellation until the verification window actually closes', async () => {
        vi.useFakeTimers(); try {
            const f = fixture(), cancellation = new AbortController(); f.context.signal = cancellation.signal;
            let release: () => void, settled = false;
            vi.mocked(f.win.Close).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
            const running = FetchManagedCatalogWindow(f.win, new Request('https://fixture.invalid'), '', '', 0, 180000, f.context, async () => FetchRedirection.Interactive).catch(() => { settled = true; });
            void f.ready.Dispatch(); await vi.advanceTimersByTimeAsync(90000); cancellation.abort(); await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(false); release(); await running; expect(settled).toBe(true);
        } finally { vi.useRealTimers(); }
    });
    it('Should continue when the real detector clears before deadline without claiming a deferred success', async () => {
        vi.useFakeTimers(); try {
            const f = fixture(); let cleared = false;
            const running = FetchManagedCatalogWindow(f.win, new Request('https://fixture.invalid'), 'script', '', 0, 180000, f.context, async () => cleared ? FetchRedirection.None : FetchRedirection.Interactive);
            void f.ready.Dispatch(); await vi.advanceTimersByTimeAsync(10000); cleared = true; void f.ready.Dispatch();
            await vi.advanceTimersByTimeAsync(1); expect(await running).toBe('content'); expect(f.win.Close).toHaveBeenCalledOnce();
        } finally { vi.useRealTimers(); }
    });
});
