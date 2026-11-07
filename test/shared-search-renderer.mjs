// Accepted catalogs, real dedicated Worker and real Classic UI. No live website requests.
(async () => {
    const { SearchWorkerClient } = await import('/src/engine/search/SearchWorkerClient.ts');
    const { GetLocalSearchController } = await import('/src/engine/search/LocalSearchController.ts');
    const { SiteIndexManager } = await import('/src/engine/catalog/SiteIndexManager.ts');
    const { SiteIndexRepository, SaveManualMediaList } = await import('/src/engine/catalog/SiteIndexRepository.ts');
    const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
    const { MangaScraper, Manga } = await import('/src/engine/providers/MangaPlugin.ts');
    const { Tags } = await import('/src/engine/Tags.ts');
    const { Observable } = await import('/src/engine/Observable.ts');
    const { Settings } = await import('/src/frontend/classic/stores/Settings.svelte.ts');
    const { Store: UI } = await import('/src/frontend/classic/stores/Stores.svelte.ts');
    const { default: App } = await import('/src/frontend/classic/App.svelte');
    const { mount, unmount, tick } = await import('/@id/svelte');
    const checks = [];
    const record = (name, passed) => { if (!passed) throw new Error(name); checks.push({ name, passed }); console.log(name, passed); };
    const wait = async predicate => { const end = Date.now() + 20000; while (!await predicate()) { if (Date.now() > end) throw new Error('Search wait failed: ' + document.body.innerText.slice(-1600)); await new Promise(resolve => setTimeout(resolve, 20)); } };
    const input = async (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); await tick(); };
    const click = async text => { const element = [...document.querySelectorAll('button,a')].find(el => el.textContent.trim() === text && el.checkVisibility()); if (!element) throw new Error('Missing search action ' + text); element.click(); await tick(); };
    const storage = new StorageControllerBrowser();
    let catalogs = 0, chapters = 0, images = 0, openedId;
    class Local extends MangaScraper {
        async Initialize() {}
        async FetchMangas() { catalogs++; throw new Error('Search must not fetch a catalog'); }
        async FetchChapters(manga) { chapters++; openedId = manga.Identifier; if (manga.Identifier === 'gone') throw new Error('Fixture manga no longer available'); return []; }
        async FetchPages() { images++; throw new Error('Search must not fetch pages'); }
        async FetchImage() { images++; throw new Error('Search must not fetch images'); }
    }
    const make = (id, title, tag = Tags.Language.Arabic) => new Local(id, title, 'https://fixture.invalid', tag).CreatePlugin(storage, HakuNeko.SettingsManager);
    const a = make('search-a', 'A مصدر عربي'), b = make('search-b', 'B مصدر عربي'), large = make('search-large', 'C Large Arabic'), large2 = make('search-large2', 'D Large Arabic');
    const multi = make('search-multi', 'Multilingual only', Tags.Language.Multilingual);
    const originalSites = HakuNeko.PluginController.WebsitePlugins;
    HakuNeko.PluginController.WebsitePlugins = [a, b, large, large2, multi];
    HakuNeko.BookmarkPlugin.IsBookmarked = () => false;
    HakuNeko.ItemflagManager = { ContainerFlagsEventChannel: new Observable(null), GetUnFlaggedItems: async () => [], GetItemFlagType: async () => null };
    const repo = new SiteIndexRepository();
    const full = { state: 'complete', evidence: 'Closed isolated catalog fixture, all entries enumerated' };
    const rowsA = [{ id: 'common', title: 'One Piece' }, { id: 'arabic', title: 'إِرَادَةُ الأَبْطَال' }, { id: 'gone', title: 'Gone Manga' }, ...Array.from({ length: 130 }, (_, i) => ({ id: `pirate-${String(i).padStart(3, '0')}`, title: `Pirate ${String(i).padStart(3, '0')}` }))];
    const source = (plugin, rows, coverage = full) => ({ id: plugin.Identifier, Catalog: async function* () { yield { items: rows, terminal: true, coverage }; }, Published: () => plugin.InvalidateMediaListCache() });
    const bulk = async sources => { const manager = new SiteIndexManager(repo, () => sources, navigator.locks, { timeoutMs: 30000, delayMs: 1, retryMs: 1 }); await manager.Start(); await wait(() => !manager.Activity.Value.owned); };
    await navigator.locks.request('haruneko-site-index', async () => {});
    await bulk([source(a, rowsA), source(b, [{ id: 'common', title: 'One Piece' }], { state: 'unknown', evidence: 'Fixture connector supplies no complete-index proof' })]);
    await bulk([{ id: b.Identifier, Catalog: async function* () { throw new Error('Fixture network unavailable'); } }]);
    await SaveManualMediaList(multi.Identifier, [{ id: 'multi', title: 'One Piece' }]);
    const client = new SearchWorkerClient();
    const sites = [a, b].map(site => ({ id: site.Identifier, title: site.Title }));
    const query = (value, page = 1, siteId = '', fuzzy = false) => client.Search({ query: value, page, siteId, fuzzy }, sites);
    let result = await query('ONE PIECE');
    record('The actual Worker groups same-title results by source and retains both composite identities', result.total === 2 && result.groups.flatMap(group => group.rows).map(row => JSON.stringify([row.siteId, row.mangaId])).join('|') === '["search-a","common"]|["search-b","common"]');
    record('Fresh and failed-retained catalogs remain searchable with their actual metadata and timestamps', result.groups[0].metadata.state === 'succeeded' && result.groups[1].metadata.state === 'stale' && !!result.groups[1].metadata.lastSuccess);
    record('Arabic diacritics and hamza forms match without rewriting the original displayed title', (await query('ارادة الابطال')).groups.flatMap(group => group.rows)[0].title === 'إِرَادَةُ الأَبْطَال');
    record('Partial English search and optional approximate matching use only the source title', (await query('piece')).total === 2 && (await query('one peice', 1, '', true)).total === 2 && (await query('one peice')).total === 0);
    record('Source filters and missing terms produce local-only counts', (await query('piece', 1, b.Identifier)).total === 1 && (await query('absent-title')).total === 0);
    await bulk([source(a, [...rowsA, { id: 'bulk-new', title: 'Bulk New Title' }])]);
    record('A successful bulk revision becomes searchable without returning an older cached result', (await query('bulk new')).groups.flatMap(group => group.rows)[0].mangaId === 'bulk-new');
    await SaveManualMediaList(a.Identifier, [...rowsA, { id: 'manual-new', title: 'Manual New Title' }]);
    record('A manual revision invalidates normalized cache and removes obsolete accepted rows', (await query('manual new')).total === 1 && (await query('bulk new')).total === 0);
    record('Checking a removed local reference never turns it into a synthetic manga identity', await client.Find(a.Identifier, 'bulk-new') === null);
    const corpusA = Array.from({ length: 50000 }, (_, i) => ({ id: `a${i}`, title: `Large Manga ${String(i).padStart(5, '0')}` }));
    const corpusB = Array.from({ length: 30000 }, (_, i) => ({ id: `b${i}`, title: `Large Manga ${String(i).padStart(5, '0')}` }));
    await SaveManualMediaList(large.Identifier, corpusA); await SaveManualMediaList(large2.Identifier, corpusB);
    const largeSites = [large, large2].map(site => ({ id: site.Identifier, title: site.Title }));
    const before = await ipcRenderer.invoke('SearchTest::Memory');
    let heartbeats = 0; const heartbeat = setInterval(() => heartbeats++, 5);
    const cold = await client.Search({ query: 'large manga', siteId: '', page: 1, fuzzy: false }, largeSites);
    const warm = await client.Search({ query: 'large manga', siteId: '', page: 800, fuzzy: false }, largeSites);
    clearInterval(heartbeat);
    const after = await ipcRenderer.invoke('SearchTest::Memory');
    record('80000 local titles search off the UI thread and return at most 25 result rows', cold.total === 80000 && warm.total === 80000 && warm.groups.flatMap(group => group.rows).length === 25 && heartbeats > 5);
    record('The derived Worker cache stays within its documented entry and string-payload budgets', warm.cachedEntries <= 100000 && warm.estimatedCacheBytes <= 64 * 1024 * 1024);
    console.log('Shared search fixture metrics:', JSON.stringify({ entries: 80000, coldMs: Math.round(cold.elapsedMs), warmMs: Math.round(warm.elapsedMs), heartbeats, cachedEntries: warm.cachedEntries, estimatedStringBytes: warm.estimatedCacheBytes, rendererMemoryBeforeKiB: before, rendererMemoryAfterKiB: after }));
    client.Close();
    const controller = GetLocalSearchController(); await controller.Initialize();
    Settings.StartupGuideEnabled.Value = false; Settings.ContentPanel.Value = false;
    UI.contentscreen = '/isolated-search'; UI.page = 'arabic-manga'; UI.hubSection = 'search'; UI.selectedPlugin = undefined; UI.selectedMedia = undefined; UI.selectedItem = undefined;
    controller.SetActive(true);
    const target = document.createElement('div'); document.body.append(target);
    const app = mount(App, { target });
    await wait(() => document.querySelector('[data-testid="shared-search-query"]') && !document.querySelector('[data-testid="shared-search-query"]').disabled);
    await input(document.querySelector('[data-testid="shared-search-query"]'), 'one piece');
    await wait(() => controller.State.Value.status === 'ready');
    record('The actual Classic hub shows grouped results and excludes multilingual-only sources', document.querySelectorAll('[data-testid="shared-search-result"]').length === 2 && ![...document.querySelectorAll('[data-testid="shared-search-group"]')].some(element => element.dataset.sourceId === multi.Identifier));
    record('The hub labels old indexes and uncertain coverage without asserting image health', document.querySelector('[data-testid="shared-search"]').textContent.includes('Cached library') && document.querySelector('[data-testid="shared-search"]').textContent.includes('Unconfirmed coverage'));
    const requestBaseline = { catalogs, chapters, images };
    await input(document.querySelector('[data-testid="shared-search-query"]'), 'pir');
    await input(document.querySelector('[data-testid="shared-search-query"]'), 'pirate');
    const filter = document.querySelector('[data-testid="shared-search-site"]'); filter.value = a.Identifier; filter.dispatchEvent(new Event('change', { bubbles: true })); await tick();
    await wait(() => controller.State.Value.status === 'ready' && controller.State.Value.result.total === 130);
    await click('Next'); await wait(() => controller.State.Value.status === 'ready' && controller.State.Value.preference.page === 2);
    record('Typing, filtering and paginating never calls website catalog, chapter, image or download entry points', catalogs === requestBaseline.catalogs && chapters === requestBaseline.chapters && images === requestBaseline.images && HakuNeko.DownloadManager.Queue.Value.length === 0);
    record('The DOM contains only the selected page of matching manga rows', document.querySelectorAll('[data-testid="shared-search-result"]').length === 25);
    const panel = document.querySelector('[data-testid="shared-search-scroll"]'); panel.scrollTop = 300; panel.dispatchEvent(new Event('scroll')); await new Promise(resolve => setTimeout(resolve, 150));
    const position = panel.scrollTop; const chosen = document.querySelector('[data-testid="shared-search-result"]'); const mangaId = chosen.dataset.mangaId;
    chosen.querySelector('button').click(); await wait(() => UI.page === 'media' && openedId === mangaId);
    record('Opening a result uses the original native plugin and source manga identity without downloading pages', UI.selectedPlugin === a && UI.selectedMedia.Identifier === mangaId && images === 0 && HakuNeko.DownloadManager.Queue.Value.length === 0);
    [...document.querySelectorAll('a')].find(element => element.textContent.trim() === 'Arabic Manga').click(); await tick();
    await wait(() => document.querySelector('[data-testid="shared-search-scroll"]') && controller.State.Value.status === 'ready' && document.querySelector('[data-testid="shared-search-scroll"]').scrollTop === position);
    record('Returning to search preserves query, source filter, page and scroll position', controller.State.Value.preference.query === 'pirate' && controller.State.Value.preference.siteId === a.Identifier && controller.State.Value.preference.page === 2 && document.querySelector('[data-testid="shared-search-scroll"]').scrollTop === position);
    await input(document.querySelector('[data-testid="shared-search-query"]'), 'gone manga'); await wait(() => controller.State.Value.status === 'ready');
    document.querySelector('[data-testid="shared-search-result"] button').click(); await wait(() => UI.page === 'media' && document.body.textContent.includes('Plugin failed to load items'));
    record('A missing live manga uses the existing source error path and leaves local search state intact', controller.State.Value.preference.query === 'gone manga' && controller.State.Value.result.total === 1 && images === 0);
    [...document.querySelectorAll('a')].find(element => element.textContent.trim() === 'Arabic Manga').click(); await tick();
    await wait(() => document.querySelector('[data-testid="shared-search-query"]'));
    await input(document.querySelector('[data-testid="shared-search-query"]'), 'one piece');
    await wait(() => controller.State.Value.status === 'ready');
    await SaveManualMediaList(a.Identifier, [...rowsA, { id: 'another', title: 'One Piece Extra' }]);
    await wait(() => controller.State.Value.status === 'ready' && controller.State.Value.result.total === 2); // Filter remains on source A.
    record('Accepted-list notifications refresh a visible search after a manual publication', document.querySelectorAll('[data-testid="shared-search-result"]').length === 2);
    const all = document.querySelector('[data-testid="shared-search-site"]'); all.value = ''; all.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => controller.State.Value.status === 'ready' && controller.State.Value.result.total === 3);
    await ipcRenderer.invoke('SearchTest::Capture');
    await unmount(app); target.remove();
    controller.Query({ query: 'one piece', siteId: '', page: 1, fuzzy: false, scroll: 0, active: false }, 0); await wait(() => controller.State.Value.status === 'ready'); await controller.Flush();
    UI.page = 'media'; UI.hubSection = 'sites'; UI.selectedPlugin = undefined; UI.selectedMedia = undefined;
    HakuNeko.PluginController.WebsitePlugins = originalSites;
    record('Restorable shared-search preferences are committed without creating a selective download queue', HakuNeko.DownloadManager.Queue.Value.length === 0);
    return checks;
})()
