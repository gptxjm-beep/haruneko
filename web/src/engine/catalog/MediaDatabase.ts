import { Store } from '../StorageController';

const DataBase = 'HakuNeko';

export const enum InternalStore {
    TemporaryData = 'TemporaryData',
}

export type UnitedStore = Store | InternalStore;

const VersionUpgrades = [
    // V0 => V1
    function V1(db: IDBDatabase) {
        db.createObjectStore(Store.Settings);
    },
    // V1 => V2
    function V2(db: IDBDatabase) {
        db.createObjectStore(Store.Bookmarks);
    },
    // V2 => V3
    function V3(db: IDBDatabase) {
        db.createObjectStore(Store.MediaLists);
    },
    // V3 => V4
    function V4(db: IDBDatabase) {
        db.createObjectStore(InternalStore.TemporaryData);
    },
    // V4 => V5
    function V5(db: IDBDatabase) {
        db.createObjectStore(Store.Itemflags);
    },
    // V5 => V6: metadata and isolated candidates; MediaLists remains the accepted catalog.
    function V6(db: IDBDatabase) {
        db.createObjectStore('SiteIndexMetadata', { keyPath: 'siteId' });
        db.createObjectStore('SiteIndexJob', { keyPath: 'key' });
        const staging = db.createObjectStore('SiteIndexStaging', { keyPath: ['attemptId', 'offset'] });
        staging.createIndex('attempt', 'attemptId');
    },
];

const Version = VersionUpgrades.length;

export class MediaDatabaseBlockedError extends Error {}

export async function OpenMediaDatabase(options: { blockedTimeoutMs?: number } = {}): Promise<IDBDatabase> {
    const connection = indexedDB.open(DataBase, Version);
    return new Promise<IDBDatabase>((resolve, reject) => {
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        connection.onblocked = () => {
            timer ??= setTimeout(() => {
                expired = true;
                reject(new MediaDatabaseBlockedError('Close an older application window before retrying the database upgrade'));
            }, options.blockedTimeoutMs ?? 5000);
        };
        connection.onupgradeneeded = (event: IDBVersionChangeEvent) => {
            if (expired) { connection.transaction!.abort(); return; }
            const db = connection.result;
            for(let version = event.oldVersion; version < event.newVersion; version++) VersionUpgrades[version](db);
        };
        connection.onsuccess = () => {
            clearTimeout(timer);
            const db = connection.result;
            if (expired) { db.close(); return; }
            // Close only this connection; active transactions finish before a later upgrade can proceed.
            db.onversionchange = () => db.close();
            resolve(db);
        };
        connection.onerror = () => { clearTimeout(timer); if (!expired) reject(connection.error); };
    });
}
