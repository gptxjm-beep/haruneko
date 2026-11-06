import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageControllerBrowser } from './StorageControllerBrowser';

describe('Temporary IndexedDB transaction durability', () => {
    afterEach(() => vi.unstubAllGlobals());
    it.each(['save', 'remove'])('Should reject a %s transaction quota abort even after the request succeeded', async operation => {
        vi.stubGlobal('navigator', { storage: { persist: async () => true } });
        const storage = new StorageControllerBrowser();
        const query = { onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined };
        const transaction = { error: new DOMException('Quota was exhausted', 'QuotaExceededError'),
            oncomplete: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined,
            objectStore: () => ({ put: () => query, delete: () => query }),
            commit: () => { queueMicrotask(() => { query.onsuccess?.(); queueMicrotask(() => transaction.onabort?.()); }); },
        };
        const database = { transaction: () => transaction, close: vi.fn() };
        vi.spyOn(storage as unknown as { Connect: () => Promise<unknown> }, 'Connect').mockResolvedValue(database);
        const result = operation === 'save' ? storage.SaveTemporary(new Blob(['page'])) : storage.RemoveTemporary('owned-key');
        await expect(result).rejects.toMatchObject({ name: 'QuotaExceededError' });
        expect(database.close).toHaveBeenCalledOnce();
    });
});
