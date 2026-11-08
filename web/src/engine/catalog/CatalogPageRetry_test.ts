import { describe, expect, it, vi } from 'vitest';
import { FetchCatalogPage } from './CatalogPageRetry';
describe('Conservative same-page catalog retry', () => {
    it('Should retry a transient 521 on the current page without skipping or repeating already accepted pages', async () => {
        vi.useFakeTimers();
        try {
            const calls: number[] = [], accepted: number[] = []; let failed = false, status = 200;
            const running = (async () => { for (let page = 0; page < 3; page++) accepted.push(await FetchCatalogPage(async () => { calls.push(page); if (page === 1 && !failed) { failed = true; status = 521; throw new Error('521'); } status = 200; return page; }, () => status)); })();
            await vi.runAllTimersAsync(); await running;
            expect(calls).toEqual([0, 1, 1, 2]); expect(accepted).toEqual([0, 1, 2]);
        } finally { vi.useRealTimers(); }
    });
    it('Should never retry access rejection and cancel a pending backoff', async () => {
        const forbidden = vi.fn().mockRejectedValue(new Error('403'));
        await expect(FetchCatalogPage(forbidden, () => 403)).rejects.toThrow('403'); expect(forbidden).toHaveBeenCalledOnce();
        const stop = new AbortController(), fetch = vi.fn().mockRejectedValue(new Error('521'));
        const running = FetchCatalogPage(fetch, () => 521, stop.signal); const result = expect(running).rejects.toMatchObject({ name: 'AbortError' });
        await Promise.resolve(); stop.abort(); await result; expect(fetch).toHaveBeenCalledOnce();
    });
});
