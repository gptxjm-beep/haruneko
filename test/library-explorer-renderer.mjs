// Existing worker -> shared SQLite cart -> native selective queue; original reader, no live hosts.
(async () => {
    const { MangaScraper, Chapter, Page } = await import('/src/engine/providers/MangaPlugin.ts');
    const { Tags } = await import('/src/engine/Tags.ts');
    const { SaveManualMediaList } = await import('/src/engine/catalog/SiteIndexRepository.ts');
    const { GetExplorerSearchController, GetLocalSearchController } = await import('/src/engine/search/LocalSearchController.ts');
    const { GetSelectionCart } = await import('/src/engine/archive/SelectionCartController.ts');
    const { GetSelectiveQueueController } = await import('/src/engine/archive/SelectiveQueueController.ts');
    const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts');
    const { Store: UI } = await import('/src/frontend/classic/stores/Stores.svelte.ts');
    const { default: App } = await import('/src/frontend/classic/App.svelte');
    const { mount, unmount, tick } = await import('/@id/svelte');
    const checks = [], cart = GetSelectionCart(), queue = GetSelectiveQueueController(), client = new ArchiveClient();
    const record = (name, passed) => { if (!passed) throw new Error(name); checks.push({ name, passed }); console.log(name, passed); };
    const wait = async test => { const end = Date.now() + 15000; while (!await test()) { if (Date.now() > end) throw new Error('Explorer timeout: ' + document.body.innerText.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 20)); } };
    const canvas = new OffscreenCanvas(2, 2); canvas.getContext('2d').fillRect(0,0,2,2); const image = await canvas.convertToBlob();
    let catalogs = 0, lists = 0, images = 0;
    class Fixture extends MangaScraper {
        async Initialize() {}
        async FetchMangas() { catalogs++; throw new Error('Opening Explorer must not fetch catalogs'); }
        GetArchiveChapterOrder() { return { order: 'descending', evidence: 'Explicit local fixture' }; }
        async FetchChapters(manga) { lists++; return ['3','2','1'].map(id => new Chapter(this, manga, id, `Chapter ${id}`)); }
        async FetchPages(chapter) { return [new Page(this, chapter, new URL('https://fixture.invalid/page'))]; }
        async FetchImage() { images++; return image; }
    }
    const storage = HakuNeko.StorageController ?? HakuNeko.DownloadManager.storageController;
    const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
    const browser = new StorageControllerBrowser();
    const sites = ['explorer-a','explorer-b'].map(id => new Fixture(id, `Explorer ${id}`, 'https://fixture.invalid', Tags.Language.Arabic).CreatePlugin(browser, HakuNeko.SettingsManager));
    const original = HakuNeko.PluginController.WebsitePlugins; HakuNeko.PluginController.WebsitePlugins = sites;
    const budget = await client.Request({ operation: 'queue-summary' });
    await SaveManualMediaList(sites[0].Identifier, Array.from({ length: 20492 }, (_, n) => ({ id: `m-${n}`, title: `Explorer Manga ${String(n).padStart(5,'0')}` })));
    await SaveManualMediaList(sites[1].Identifier, [{ id: 'm-0', title: 'Explorer Manga 00000' }]);
    UI.page = 'arabic-manga'; UI.hubSection = 'explorer'; UI.explorerReference = undefined; UI.selectedItem = undefined;
    const target = document.createElement('div'); document.body.append(target); const app = mount(App, { target });
    const explorer = () => document.querySelector('[data-testid="library-explorer"]');
    await wait(() => explorer()?.querySelector('.filters select'));
    const choose = id => { const field = explorer().querySelector('.filters select'); field.value = id; field.dispatchEvent(new Event('change', { bubbles: true })); };
    choose('explorer-a'); await wait(() => explorer().querySelectorAll('.mangas article').length === 25);
    record('Explorer browses a 20492-entry local library with only 25 DOM rows and zero source requests', catalogs === 0 && lists === 0 && images === 0 && explorer().textContent.includes('20492'));
    const mangaRef = { siteId: sites[0].Identifier, siteName: sites[0].Title, mangaId: 'm-0', title: 'Explorer Manga 00000' };
    explorer().querySelector('.mangas article input').click(); await wait(() => !!cart.Find(mangaRef));
    record('Selecting a manga creates one symbolic all-chapters cart entry without loading chapters', lists === 0 && !cart.Find(mangaRef).chapters);
    explorer().querySelector('.mangas article button').click(); await wait(() => explorer().querySelectorAll('.chapters article').length === 3);
    await wait(() => !explorer().querySelector('.chapters article input').disabled);
    explorer().querySelectorAll('.chapters article input')[1].click(); await wait(() => cart.Find(mangaRef)?.mode === 'except');
    record('Excluding one native chapter gives a durable partial 2/3 selection by original identity', cart.Find(mangaRef).ids.join(',') === '2' && explorer().querySelector('.mangas article input').indeterminate);
    const previousSearch = GetLocalSearchController().State.Value.preference.query;
    choose('explorer-b'); await wait(() => explorer().querySelectorAll('.mangas article').length === 1); explorer().querySelector('.mangas article input').click();
    await wait(() => cart.State.Value.items.some(item => item.siteId === 'explorer-b'));
    choose('explorer-a'); await wait(() => explorer().querySelectorAll('.mangas article').length === 25);
    record('Changing sites keeps shared selections and does not overwrite the independent Search query', cart.Find(mangaRef).ids[0] === '2' && GetLocalSearchController().State.Value.preference.query === previousSearch);
    explorer().querySelector('.mangas article button').click(); await wait(() => explorer().querySelectorAll('.chapters article').length === 3);
    await ipcRenderer.invoke('ArchiveHubTest::Capture');
    explorer().querySelector('.chapters article button').click(); await wait(() => explorer().querySelector('.reader'));
    await wait(() => images > 0);
    [...explorer().querySelectorAll('button')].find(button => button.textContent.trim() === 'Back to Explorer').click(); await tick();
    record('The original isolated reader previews a chapter and returns without changing its cart scope or native Media List selection', cart.Find(mangaRef).ids[0] === '2' && UI.selectedItem === undefined);
    await cart.Transfer();
    const queued = (await queue.List()).filter(row => row.siteId.startsWith('explorer-'));
    record('Shared cart transfers exact chapter scope to the existing queue, separates identical IDs by source and never starts downloads', queued.length === 2 && queued.find(row => row.siteId === 'explorer-a').scope.ids.join(',') === '3,1' && catalogs === 0 && (await client.Request({ operation: 'queue-summary' })).chaptersStarted === budget.chaptersStarted);
    await cart.Save(mangaRef, { mode: 'except', ids: ['2'], order: 'source', chapters: ['3','2','1'].map(id => ({ id, title: `Chapter ${id}` })) });
    await cart.Transfer();
    record('A changed cart scope stays in the cart with a clear reason when Downloads already owns a different scope', !!cart.Find(mangaRef)?.reason);
    [...explorer().querySelectorAll('button')].find(button => button.textContent.startsWith('Selection Cart (')).click();
    await wait(() => explorer().querySelector('[data-testid="selection-cart"]'));
    const selectedCard = () => [...explorer().querySelectorAll('[data-testid="selection-cart"] article')].find(card => card.textContent.includes(mangaRef.title));
    [...selectedCard().querySelectorAll('button')].find(button => button.textContent.trim() === 'Supplement Downloads…').click(); await tick();
    [...explorer().querySelectorAll('button')].find(button => button.textContent.trim() === 'Confirm supplementary transfer').click();
    await wait(() => !cart.Find(mangaRef));
    record('Explicit supplementary transfer updates only the pending owned scope and keeps cumulative budgets and existing downloads', (await client.Request({ operation: 'queue-summary' })).chaptersStarted === budget.chaptersStarted && (await queue.List()).filter(row => row.siteId.startsWith('explorer-')).length === 2);
    await cart.Save(mangaRef, { mode: 'except', ids: ['2'], order: 'source', chapters: ['3','2','1'].map(id => ({ id, title: `Chapter ${id}` })) });
    globalThis.explorerFixture = { siteId: mangaRef.siteId, mangaId: mangaRef.mangaId };
    globalThis.selectiveQueueFixture.selected = (await queue.Selections()).length; globalThis.selectiveQueueFixture.queued = (await queue.List()).length;
    await unmount(app); target.remove(); HakuNeko.PluginController.WebsitePlugins = original;
    void storage; return checks;
})()
