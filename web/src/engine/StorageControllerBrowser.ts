import { type StorageController, Store } from './StorageController';

import { InternalStore, OpenMediaDatabase, type UnitedStore } from './catalog/MediaDatabase';
import { SaveManualMediaList } from './catalog/SiteIndexRepository';

/**
 * A storage controller that uses the {@link indexedDB} and the {@link https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API|File System Access API}.
 * It is intended to be used within modern web-browsers.
 */
export class StorageControllerBrowser implements StorageController {

    constructor() {
        navigator.storage.persist().catch(console.warn);
    }

    private Connect(): Promise<IDBDatabase> { return OpenMediaDatabase(); }

    private async SaveIDB<T>(value: T, store: UnitedStore, key?: string): Promise<void> {
        const db = await this.Connect();
        const tx = db.transaction(store, 'readwrite');
        const bucket = tx.objectStore(store);
        const queries = key ? [ bucket.put(value, key) ] : Object.keys(value).map(key => bucket.put(value[key], key));
        await this.CommitWrite(db, tx, queries);
    }

    private async CommitWrite(db: IDBDatabase, tx: IDBTransaction, queries: IDBRequest[]): Promise<void> {
        const promises = queries.map(query => new Promise<void>((resolve, reject) => {
            query.onsuccess = () => resolve(/*query.result*/);
            query.onerror = () => reject(query.error);
        }));
        const committed = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error ?? new DOMException('Storage transaction aborted', 'AbortError'));
        });
        try { await Promise.all([...promises, committed, Promise.resolve().then(() => tx.commit())]); }
        finally { db.close(); }
    }

    private async LoadIDB<T>(store: UnitedStore, key?: string): Promise<T> {
        const db = await this.Connect();
        const tx = db.transaction(store, 'readonly');
        const bucket = tx.objectStore(store);
        const query = key ? bucket.get(key) : bucket.getAll();
        const promise = new Promise<T>((resolve, reject) => {
            query.onsuccess = () => resolve(query.result as T);
            query.onerror = () => reject(query.error);
        });
        tx.oncomplete = () => db.close();
        tx.commit();
        return promise;
    }

    private async RemoveIDB(store: UnitedStore, ...keys: string[]): Promise<void> {
        const db = await this.Connect();
        const tx = db.transaction(store, 'readwrite');
        const bucket = tx.objectStore(store);
        const queries = keys.length > 0 ? keys.map(key => bucket.delete(key)) : [ bucket.clear() ];
        await this.CommitWrite(db, tx, queries);
    }

    public async SavePersistent<T>(value: T, store: Store, key?: string): Promise<void> {
        //console.warn('StorageController.SavePersistent()', '=>', 'Not fully implemented!');
        // May instead use: https://developer.chrome.com/docs/extensions/reference/storage/
        //                  chrome.storage.local.set({ key: data }, () => {});
        //return localStorage.setItem(`${store}.${key}`, JSON.stringify(value));
        if (store === Store.MediaLists && key) return SaveManualMediaList(key, value);
        return this.SaveIDB(value, store, key);
    }

    public async LoadPersistent<T>(store: Store, key?: string): Promise<T> {
        //console.warn('StorageController.LoadPersistent()', '=>', 'Not fully implemented!');
        // May instead use: https://developer.chrome.com/docs/extensions/reference/storage/
        //                  chrome.storage.local.get(key, data => data[key]);
        //return JSON.parse(localStorage.getItem(`${store}.${key}`)) as T;
        return this.LoadIDB(store, key);
    }

    public async RemovePersistent(store: Store, ...keys: string[]): Promise<void> {
        //console.warn('StorageController.RemovePersistent()', '=>', 'Not fully implemented!');
        // May instead use: https://developer.chrome.com/docs/extensions/reference/storage/
        //                  chrome.storage.local.remove(key, () => {});
        //return localStorage.removeItem(`${store}.${key}`);
        return this.RemoveIDB(store, ...keys);
    }

    public async SaveTemporary<T>(value: T): Promise<string> {
        const key = Date.now().toString() + Math.random().toString();
        await this.SaveIDB(value, InternalStore.TemporaryData, key);
        return key;
    }

    public async LoadTemporary<T>(key: string): Promise<T> {
        return this.LoadIDB(InternalStore.TemporaryData, key);
    }

    public async RemoveTemporary(...keys: string[]): Promise<void> {
        return this.RemoveIDB(InternalStore.TemporaryData, ...keys);
    }
}
