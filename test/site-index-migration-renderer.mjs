// Fresh isolated profile: seed the real legacy v5 schema before exercising the shared v6 upgrader.
(async () => {
    const checks = [];
    const request = indexedDB.open('HakuNeko', 5);
    request.onupgradeneeded = () => { for (const name of ['Settings', 'Bookmarks', 'MediaLists', 'TemporaryData', 'Itemflags']) request.result.createObjectStore(name); };
    const legacy = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
        const tx = legacy.transaction(['Settings', 'MediaLists', 'TemporaryData'], 'readwrite');
        tx.objectStore('Settings').put({ preserved: true }, 'migration-fixture');
        tx.objectStore('MediaLists').put([{ id: '/legacy', title: 'Legacy manga' }], 'migration-fixture');
        tx.objectStore('TemporaryData').put('preserved-test-page', 'migration-fixture');
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    legacy.close();
    const { OpenMediaDatabase } = await import('/src/engine/catalog/MediaDatabase.ts');
    const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
    const { Store } = await import('/src/engine/StorageController.ts');
    const db = await OpenMediaDatabase();
    checks.push({ name: 'IndexedDB v5 upgrades in place to v6 with separate metadata/job/staging stores', passed: db.version === 6 && ['SiteIndexMetadata', 'SiteIndexJob', 'SiteIndexStaging'].every(name => db.objectStoreNames.contains(name)) }); db.close();
    const storage = new StorageControllerBrowser();
    checks.push({ name: 'Catalog schema upgrade preserves legacy MediaLists and settings', passed: (await storage.LoadPersistent(Store.MediaLists, 'migration-fixture'))[0].id === '/legacy' && (await storage.LoadPersistent(Store.Settings, 'migration-fixture')).preserved === true });
    checks.push({ name: 'Catalog schema upgrade preserves temporary image storage', passed: await storage.LoadTemporary('migration-fixture') === 'preserved-test-page' });
    for (const check of checks) { if (!check.passed) throw new Error(check.name); console.log(check.name, true); }
    return checks;
})()
