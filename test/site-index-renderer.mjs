// Real IndexedDB in the isolated Electron profile. No live website or content requests.
(async () => {
    const { SiteIndexRepository, SaveManualMediaList } = await import('/src/engine/catalog/SiteIndexRepository.ts');
    const { SiteIndexManager } = await import('/src/engine/catalog/SiteIndexManager.ts');
    const { OpenMediaDatabase } = await import('/src/engine/catalog/MediaDatabase.ts');
    const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
    const { Store } = await import('/src/engine/StorageController.ts');
    const { MangaScraper, Manga } = await import('/src/engine/providers/MangaPlugin.ts');
    const { ArabicCatalogSources, GetSiteIndexController } = await import('/src/engine/catalog/SiteIndexController.ts');
    const { Tags } = await import('/src/engine/Tags.ts');
    const { mount, unmount, tick } = await import('/@id/svelte');
    const { default: Hub } = await import('/src/frontend/classic/components/arabic-manga/ArabicManga.svelte');
    const { Store: UI } = await import('/src/frontend/classic/stores/Stores.svelte.ts');
    // Wait for any final metadata-only view initialization from the preceding UI test.
    await GetSiteIndexController().Initialize();
    await navigator.locks.request('haruneko-site-index', async () => {});
    const repository = new SiteIndexRepository(), storage = new StorageControllerBrowser();
    const checks = [];
    const record = (name, passed) => { if (!passed) throw new Error(name); checks.push({ name, passed }); console.log(name, passed); };
    const wait = async predicate => { const end = Date.now() + 30000; while (!await predicate()) { if (Date.now() > end) throw new Error('Catalog wait timed out: ' + document.body.innerText.slice(-2000)); await new Promise(resolve => setTimeout(resolve, 5)); } };
    const complete = { state: 'complete', evidence: 'All pages of this closed local fixture were enumerated' };
    const unknown = { state: 'unknown', evidence: 'Fixture observations without full-source proof' };
    const entries = (...ids) => ids.map(id => ({ id, title: `Manga ${id}` }));
    const source = (id, rows, coverage = unknown) => ({ id, Catalog: async function* () { yield { items: rows, terminal: true, coverage }; } });
    const manager = sources => new SiteIndexManager(repository, () => sources, navigator.locks, { timeoutMs: 30000, delayMs: 1, retryMs: 1 });
    const run = async sources => { const worker = manager(sources); await worker.Start(); await wait(() => !worker.Activity.Value.owned); return worker; };
    const saved = id => storage.LoadPersistent(Store.MediaLists, id);
    const summary = async id => (await repository.Snapshot()).sites.find(site => site.siteId === id);
    await run([source('index-good', entries('a', 'b'))]);
    record('Catalog publication atomically updates the existing canonical MediaLists and unknown coverage metadata', (await saved('index-good')).length === 2 && (await summary('index-good')).coverage.state === 'unknown' && !!(await summary('index-good')).lastSuccess);
    const prior = await summary('index-good');
    await run([source('index-good', entries('a'))]);
    record('A shrinking uncertain catalog preserves the old list and last-success receipt', (await saved('index-good')).length === 2 && (await summary('index-good')).lastSuccess >= prior.lastSuccess && (await summary('index-good')).coverage.state === 'partial');
    await run([source('index-good', entries('x', 'y', 'z'))]);
    record('A larger uncertain catalog cannot discard previously saved identities', (await saved('index-good')).map(item => item.id).sort().join(',') === 'a,b,x,y,z');
    await run([source('index-good', [])]);
    record('An empty unproven response cannot replace an existing catalog', (await saved('index-good')).length === 5 && (await summary('index-good')).state === 'review');
    await run([source('index-good', entries('a', 'b', 'c'), { state: 'partial', evidence: 'Only one page is known' })]);
    record('A valid partial response is searchable while absent older identities remain cached', (await saved('index-good')).length === 6 && (await summary('index-good')).coverage.state === 'partial');
    await run([source('index-good', entries('a'), complete)]);
    record('An explicit terminal complete-source proof permits a justified smaller catalog', (await saved('index-good')).length === 1 && (await summary('index-good')).coverage.state === 'complete');
    await run([source('index-good', [], complete)]);
    record('A proven empty fixture is distinct from temporary unproven emptiness', (await saved('index-good')).length === 0 && (await summary('index-good')).state === 'succeeded');
    const failure = { id: 'index-fail', Catalog: async function* () { throw new Error('Network offline token=must-not-be-stored'); } };
    await SaveManualMediaList('index-fail', entries('old'));
    await run([source('index-before', entries('1')), failure, source('index-after', entries('2'))]);
    record('A failing middle site retains its canonical index and does not block the following site', (await summary('index-fail')).state === 'stale' && (await saved('index-fail'))[0].id === 'old' && (await summary('index-after')).state === 'succeeded');
    record('Stored errors contain classified safe reasons rather than source secrets', !(await summary('index-fail')).error.includes('must-not-be-stored'));
    await SaveManualMediaList('index-race', entries('initial'));
    await run([{ id: 'index-race', Catalog: async function* () { await SaveManualMediaList('index-race', entries('manual-newer')); yield { items: entries('bulk-older'), terminal: true, coverage: complete }; } }]);
    record('A concurrent explicit manual refresh wins over an older bulk candidate', (await saved('index-race'))[0].id === 'manual-newer' && (await summary('index-race')).state === 'review');
    await run([source('index-atomic', entries('original'), complete)]);
    const before = await summary('index-atomic');
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) { if (this.name === Store.MediaLists && key === 'index-atomic') { this.transaction.abort(); throw new DOMException('Injected publication abort', 'AbortError'); } return originalPut.call(this, value, key); };
    try { await run([source('index-atomic', entries('replacement'), complete)]); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    record('An aborted publication preserves both canonical bytes and the previous last-success metadata', (await saved('index-atomic'))[0].id === 'original' && (await summary('index-atomic')).lastSuccess === before.lastSuccess && (await summary('index-atomic')).error === 'catalog-storage-failed');
    let heartbeat = 0;
    const timer = setInterval(() => heartbeat++, 1);
    const start = performance.now();
    await run([source('index-large', Array.from({ length: 50000 }, (_, i) => ({ id: String(i), title: `Manga ${i}` })))]);
    clearInterval(timer);
    record('A 50000-entry catalog persists without a small item cap and yields to the renderer', (await saved('index-large')).length === 50000 && heartbeat > 10);
    console.log('Catalog fixture metrics:', JSON.stringify({ entries: 50000, elapsedMs: Math.round(performance.now() - start), timerCallbacks: heartbeat }));
    const db = await OpenMediaDatabase();
    const stagedCount = await new Promise((resolve, reject) => { const tx = db.transaction('SiteIndexStaging', 'readonly'); const request = tx.objectStore('SiteIndexStaging').count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); db.close();
    record('Finished jobs release their staging batches while keeping only canonical catalogs', stagedCount === 0);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const slow = manager([{ id: 'index-slow', Catalog: async function* () { await gate; yield { items: entries('late'), terminal: true, coverage: complete }; } }]);
    await slow.Start(); await wait(() => slow.State.Value.job?.current === 'index-slow');
    const competing = manager([source('index-competing', entries('never'))]);
    let rejected = false; try { await competing.Start(); } catch { rejected = true; }
    record('The real origin-wide Web Lock rejects conflicting updaters', rejected);
    await slow.Stop(true);
    record('Cancellation saves its terminal state promptly without waiting for a legacy fetch', (await repository.Snapshot()).job.state === 'cancelled');
    release(); await wait(() => !slow.Activity.Value.owned);
    record('A late result after cancellation cannot publish a catalog', await saved('index-slow') === undefined);
    // Exercise the real hub button, native MangaPlugin adapter and registry language policy.
    let catalogCalls = 0, contentCalls = 0, releaseUI, holdUI;
    class Local extends MangaScraper {
        async Initialize() {}
        async FetchMangas(provider) { catalogCalls++; if (holdUI) await holdUI; return [new Manga(this, provider, 'native-manga', 'Native manga')]; }
        async FetchChapters() { contentCalls++; throw new Error('Content must not be requested'); }
        async FetchPages() { contentCalls++; throw new Error('Content must not be requested'); }
        async FetchImage() { contentCalls++; throw new Error('Content must not be requested'); }
    }
    const plugin = new Local('index-native-ar', 'Index Native Arabic', 'https://fixture.invalid', Tags.Language.Arabic).CreatePlugin(storage, HakuNeko.SettingsManager);
    const multi = new Local('index-native-multi', 'Index Native Multilingual', 'https://fixture.invalid', Tags.Language.Multilingual).CreatePlugin(storage, HakuNeko.SettingsManager);
    HakuNeko.PluginController.WebsitePlugins = [plugin, multi];
    UI.hubSection = 'sites';
    record('Default bulk sources require explicit Arabic and do not include multilingual-only plugins', ArabicCatalogSources([plugin, multi]).map(value => value.id).join(',') === 'index-native-ar');
    const target = document.createElement('div'); document.body.append(target);
    const hub = mount(Hub, { target }); await tick();
    await wait(() => [...target.querySelectorAll('button')].some(button => button.textContent.trim() === 'Update All Arabic Sites' && !button.disabled));
    record('Reopening the hub never starts catalog requests automatically', catalogCalls === 0);
    holdUI = new Promise(resolve => { releaseUI = resolve; });
    [...target.querySelectorAll('button')].find(button => button.textContent.trim() === 'Update All Arabic Sites').click();
    const controller = GetSiteIndexController();
    await wait(() => catalogCalls === 1 && controller.State.Value.job?.current === plugin.Identifier);
    [...target.querySelectorAll('button')].find(button => button.textContent.trim() === 'Pause Update').click();
    await wait(() => controller.State.Value.job?.state === 'paused' && controller.Activity.Value.draining);
    record('The real Pause button durably stops and explains an uncooperative legacy request', target.textContent.includes('Waiting for an older connector request') && await saved(plugin.Identifier) === undefined);
    holdUI = undefined; releaseUI(); await wait(() => !controller.Activity.Value.owned); await tick();
    [...target.querySelectorAll('button')].find(button => button.textContent.trim() === 'Resume Update').click();
    await wait(() => controller.State.Value.job?.items.some(item => item.siteId === plugin.Identifier) && !controller.Activity.Value.owned);
    record('The real Resume button restarts only the paused site without charging a connector failure for the user stop', controller.State.Value.job.items[0].attempts === 1);

    record('The real Update All button fetches only manga references through the native engine adapter', catalogCalls === 2 && contentCalls === 0 && (await saved(plugin.Identifier))[0].id === 'native-manga');
    record('The hub displays committed counts, timestamps and unproven completeness separately from image health', target.textContent.includes('Catalog saved') && target.textContent.includes('unknown') && target.textContent.includes('Last saved update'));
    await plugin.RefreshMediaListCache();
    record('Native Media List can reload the accepted local catalog without another connector fetch', plugin.Entries.Value[0].Identifier === 'native-manga' && catalogCalls === 2);
    const beforeCancel = await summary(plugin.Identifier);
    holdUI = new Promise(resolve => { releaseUI = resolve; });
    [...target.querySelectorAll('button')].find(button => button.textContent.trim() === 'Update All Arabic Sites').click();
    await wait(() => catalogCalls === 3 && controller.State.Value.job?.current === plugin.Identifier);
    [...target.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel Update').click();
    await wait(() => controller.State.Value.job?.state === 'cancelled');
    holdUI = undefined; releaseUI(); await wait(() => !controller.Activity.Value.owned);
    record('The real Cancel button preserves the previously published index and rejects a late replacement', (await summary(plugin.Identifier)).lastSuccess === beforeCancel.lastSuccess && (await saved(plugin.Identifier))[0].id === 'native-manga');
    const other = new Local('index-native-other', 'Other Arabic', 'https://fixture.invalid', Tags.Language.Arabic).CreatePlugin(storage, HakuNeko.SettingsManager);
    HakuNeko.PluginController.WebsitePlugins = [plugin, multi, other];
    await tick();
    const beforeSingle = catalogCalls;
    [...target.querySelectorAll(`[data-site-id="${plugin.Identifier}"] button`)].find(button => button.textContent.trim() === 'Update').click();
    await wait(() => catalogCalls === beforeSingle + 1 && !controller.Activity.Value.owned);
    record('A site card Update commits only that connector through the shared updater without fetching content', controller.State.Value.job.items.length === 1 && controller.State.Value.job.items[0].siteId === plugin.Identifier && await saved(other.Identifier) === undefined && contentCalls === 0);
    await unmount(hub); target.remove();
    // Leave a real interrupted job for the native harness to recover after destroying the renderer.
    const recovery = await repository.Start(['index-recovery-a', 'index-recovery-b']);
    const first = await repository.Begin(recovery.id, 'index-recovery-a'); await repository.Stage(first, 0, entries('a')); await repository.Publish(first, entries('a'), complete);
    const interrupted = await repository.Begin(recovery.id, 'index-recovery-b'); await repository.Stage(interrupted, 0, entries('partial'));
    globalThis.siteIndexRecoveryFixture = recovery.id;
    record('Interrupted catalog registration leaves prior successful sites and an unpublished candidate durably distinguishable', (await saved('index-recovery-a'))[0].id === 'a' && await saved('index-recovery-b') === undefined);
    return checks;
})()
