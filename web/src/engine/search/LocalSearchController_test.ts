import { describe, expect, it } from 'vitest';
import { LocalSearchController } from './LocalSearchController';
import { SearchPreferenceKey, type SearchResult } from './LocalSearch';
import type { StorageController } from '../StorageController';
import type { SearchWorkerClient } from './SearchWorkerClient';
const result = (total: number): SearchResult => ({ total, groups: [], revisions: {}, page: 1, pageSize: 25, elapsedMs: 1, cachedEntries: 0, estimatedCacheBytes: 0, scanned: 1 });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
describe('Shared local search view state', () => {
    it('Should persist query, source filter, page and scroll across controller recreation without fetching a site', async () => {
        let saved: unknown;
        const storage = { LoadPersistent: async () => saved, SavePersistent: async (value: unknown, _store, key: string) => { expect(key).toBe(SearchPreferenceKey); saved = structuredClone(value); } } as unknown as StorageController;
        const client = { Cancel() {}, Close() {}, Search: async () => result(200) } as unknown as SearchWorkerClient;
        const first = new LocalSearchController(storage, client, () => []); await first.Initialize();
        first.Query({ query: 'One Piece', siteId: 'site', fuzzy: true, page: 3, active: true }, 0); first.SetScroll(240); await first.Flush(); first.Close();
        const second = new LocalSearchController(storage, client, () => []); await second.Initialize();
        expect(second.State.Value.preference).toMatchObject({ query: 'One Piece', siteId: 'site', page: 3, scroll: 240, active: true, fuzzy: true }); second.Close();
    });
    it('Should never display a late old query as the current result even when transport cancellation is ignored', async () => {
        const pending: ((value: SearchResult) => void)[] = [];
        const client = { Cancel() {}, Close() {}, Search: () => new Promise(resolve => pending.push(resolve)) } as unknown as SearchWorkerClient;
        const storage = { LoadPersistent: async () => undefined, SavePersistent: async () => {} } as unknown as StorageController;
        const controller = new LocalSearchController(storage, client, () => []); await controller.Initialize();
        controller.Query({ query: 'old' }, 0); await tick(); controller.Query({ query: 'new' }, 0); await tick();
        pending[1](result(2)); await tick(); pending[0](result(1)); await tick();
        expect(controller.State.Value.result!.total).toBe(2); expect(controller.State.Value.preference.query).toBe('new'); controller.Close();
    });
    it('Should preserve user edits made while saved preferences are loading', async () => {
        let loaded: (value: unknown) => void;
        const storage = { LoadPersistent: () => new Promise(resolve => { loaded = resolve; }), SavePersistent: async () => {} } as unknown as StorageController;
        const client = { Cancel() {}, Close() {} } as unknown as SearchWorkerClient;
        const controller = new LocalSearchController(storage, client, () => []); const initializing = controller.Initialize(); controller.SetActive(false);
        loaded!({ query: 'Saved query', page: 4, scroll: 120, active: true }); await initializing;
        expect(controller.State.Value.preference).toMatchObject({ query: 'Saved query', page: 4, scroll: 120, active: false }); controller.Close();
    });
    it('Should fail closed with an actionable blocked-upgrade message and no result fallback', async () => {
        const client = { Cancel() {}, Close() {}, Search: async () => { throw new Error('blocked'); } } as unknown as SearchWorkerClient;
        const controller = new LocalSearchController({ LoadPersistent: async () => undefined, SavePersistent: async () => {} } as unknown as StorageController, client, () => []);
        await controller.Initialize(); controller.Query({ query: 'test' }, 0); await tick();
        expect(controller.State.Value.status).toBe('error'); expect(controller.State.Value.result).toBeNull(); expect(controller.State.Value.error).toContain('blocked'); controller.Close();
    });
});
