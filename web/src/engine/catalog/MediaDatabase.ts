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

export async function OpenMediaDatabase(): Promise<IDBDatabase> {
    const connection = indexedDB.open(DataBase, Version);
    return new Promise<IDBDatabase>((resolve, reject) => {
        connection.onupgradeneeded = (event: IDBVersionChangeEvent) => {
            const db = connection.result; // => event.target.result
            for(let version = event.oldVersion; version < event.newVersion; version++) {
                VersionUpgrades[version](db);
            }
        };
        connection.onsuccess = () => resolve(connection.result);
        connection.onerror = () => reject(connection.error);
    });
}
