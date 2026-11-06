import { Store } from '../StorageController';
import { OpenMediaDatabase } from '../catalog/MediaDatabase';
import { EmptyIndexSite, type CatalogEntry, type IndexSite } from '../catalog/SiteIndexContract';

const Value = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
/** Reads the accepted list and its revision in the same readonly transaction. Never reads candidates. */
export async function ReadSearchSite(siteId: string, cachedRevision?: number): Promise<{ metadata: IndexSite; entries?: CatalogEntry[]; revision: number | null }> {
    const db = await OpenMediaDatabase();
    const tx = db.transaction([Store.MediaLists, 'SiteIndexMetadata'], 'readonly');
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Search transaction aborted')); });
    try {
        const metadata = await Value<IndexSite>(tx.objectStore('SiteIndexMetadata').get(siteId));
        const cached = metadata && Number.isSafeInteger(metadata.revision) && metadata.revision === cachedRevision;
        const entries = cached ? undefined : await Value<CatalogEntry[]>(tx.objectStore(Store.MediaLists).get(siteId));
        await done;
        return { metadata: metadata ?? { ...EmptyIndexSite(siteId), state: 'stale', count: Array.isArray(entries) ? entries.length : 0 },
            entries: cached ? undefined : Array.isArray(entries) ? entries : [], revision: metadata?.revision ?? null };
    } catch(error) { await done.catch(() => {}); throw error; }
    finally { db.close(); }
}
export async function ReadSearchRevisions(ids: string[]): Promise<Record<string, number | null>> {
    const db = await OpenMediaDatabase();
    const tx = db.transaction('SiteIndexMetadata', 'readonly');
    try { return Object.fromEntries(await Promise.all(ids.map(async id => [id, (await Value<IndexSite>(tx.objectStore('SiteIndexMetadata').get(id)))?.revision ?? null]))); }
    finally { db.close(); }
}
