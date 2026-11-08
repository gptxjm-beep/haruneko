import { describe, expect, it, vi } from 'vitest';
import { FetchManagedCatalogWindow, CatalogVerificationRequired, OwnCatalogWindows, BindCatalogWindow, CatalogWindowContext } from './CatalogVerification';
import { Observable } from '../Observable';
import { FetchRedirection } from '../platform/AntiScrapingDetection';
import type { IRemoteBrowserWindow } from '../platform/RemoteBrowserWindow';
function fixture() {
    const ready = new Observable<void>(undefined);
    const win = { DOMReady: ready, Open: vi.fn().mockResolvedValue(undefined), Close: vi.fn().mockResolvedValue(undefined), Show: vi.fn().mockResolvedValue(undefined), ExecuteScript: vi.fn(async (script: string) => script.includes('location.protocol') ? true : 'content') } as unknown as IRemoteBrowserWindow;
    const context = { signal: new AbortController().signal, required: vi.fn(), blocked: vi.fn() };
    return { ready, win, context };
}
describe('Catalog-owned human verification deadline and window lifetime', () => {
    it('Should never capture an independent manual request merely because it shares the catalog origin', () => {
        const owner = new AbortController(), release = OwnCatalogWindows('https://fixture.invalid', owner.signal);
        try {
            const manual = new Request('https://fixture.invalid'), managed = BindCatalogWindow(new Request('https://fixture.invalid'), owner.signal);
            expect(CatalogWindowContext(manual)).toBeUndefined(); expect(CatalogWindowContext(managed)?.signal).toBe(owner.signal);
        } finally { release(); }
    });
    it('Should hold ownership until the native window actually closes', async () => {
        vi.useFakeTimers(); try {
            const f = fixture(); let release: () => void;
            vi.mocked(f.win.Close).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
            let settled = false;
            const running = FetchManagedCatalogWindow(f.win, new Request('https://fixture.invalid'), '', '', 0, 180000, f.context, async () => FetchRedirection.Interactive).catch(() => { settled = true; });
            void f.ready.Dispatch(); await vi.advanceTimersByTimeAsync(60000); expect(settled).toBe(false); release(); await running; expect(settled).toBe(true);
        } finally { vi.useRealTimers(); }
    });
    it('Should start 60 seconds at confirmed detection, not network start, and close before deferring', async () => {
        vi.useFakeTimers(); try {
            const f = fixture();
            const running = FetchManagedCatalogWindow(f.win, new Request('https://fixture.invalid'), '', '', 0, 180000, f.context, async () => FetchRedirection.Interactive);
            const result = expect(running).rejects.toBeInstanceOf(CatalogVerificationRequired);
            await vi.advanceTimersByTimeAsync(30000); void f.ready.Dispatch(); await vi.advanceTimersByTimeAsync(59000);
            expect(f.win.Close).not.toHaveBeenCalled(); void f.ready.Dispatch();
            await vi.advanceTimersByTimeAsync(1000); await result;
            expect(f.context.required).toHaveBeenCalledOnce(); expect(f.win.Close).toHaveBeenCalledOnce();
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
