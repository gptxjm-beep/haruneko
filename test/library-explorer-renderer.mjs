// Existing worker -> shared SQLite cart -> native selective queue; original reader, no live hosts.
(async () => {
    const { MangaScraper, Chapter, Page } = await import('/src/engine/providers/MangaPlugin.ts');
    const { Tags } = await import('/src/engine/Tags.ts');
    const { SaveManualMediaList, SiteIndexRepository } = await import('/src/engine/catalog/SiteIndexRepository.ts');
    const { GetExplorerSearchController, GetLocalSearchController } = await import('/src/engine/search/LocalSearchController.ts');
    const { GetSelectionCart } = await import('/src/engine/archive/SelectionCartController.ts');
    const { GetSelectiveQueueController } = await import('/src/engine/archive/SelectiveQueueController.ts');
    const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts');
    const { Store: UI } = await import('/src/frontend/classic/stores/Stores.svelte.ts');
    const { default: App } = await import('/src/frontend/classic/App.svelte');
    const { mount, unmount, tick } = await import('/@id/svelte');
    const checks = [], cart = GetSelectionCart(), queue = GetSelectiveQueueController(), client = new ArchiveClient();
    const record = (name, passed) => { if (!passed) throw new Error(name); checks.push({ name, passed }); console.log(name, passed); };
    const wait = async (test, stage = 'UI state') => { const end = Date.now() + 15000; while (!await test()) { if (Date.now() > end) throw new Error('Explorer timeout at ' + stage + ': ' + document.body.innerText.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 20)); } };
    const canvas = new OffscreenCanvas(420, 620), ctx = canvas.getContext('2d'); ctx.fillStyle = '#efe9dd'; ctx.fillRect(0,0,420,620); ctx.fillStyle = '#273744'; ctx.font = '24px sans-serif'; ctx.fillText('Isolated chapter preview', 28, 45); for (let n=0;n<3;n++) { ctx.strokeStyle = '#526776'; ctx.strokeRect(25, 75+n*170, 370, 150); ctx.fillStyle = '#a4b4bd'; ctx.fillRect(45, 95+n*170, 140, 110); } const image = await canvas.convertToBlob();
    let catalogs = 0, lists = 0, images = 0;
    class Fixture extends MangaScraper {
        async Initialize() {}
        async FetchMangas() { catalogs++; throw new Error('Opening Explorer must not fetch catalogs'); }
        GetArchiveChapterOrder() { return { order: 'descending', evidence: 'Explicit local fixture' }; }
        async FetchChapters(manga) { lists++; return (manga.Identifier === 'm-1' ? ['1'] : ['3','2','1']).map(id => new Chapter(this, manga, id, `Chapter ${id}`)); }
        async FetchPages(chapter) { return Array.from({length: 4}, (_, n) => new Page(this, chapter, new URL(`https://fixture.invalid/page-${n}`))); }
        async FetchImage() { images++; return image; }
    }
    const storage = HakuNeko.StorageController ?? HakuNeko.DownloadManager.storageController;
    const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
    const browser = new StorageControllerBrowser();
    const sites = ['explorer-a','explorer-b','explorer-empty','explorer-new'].map(id => new Fixture(id, `Explorer ${id}`, 'https://fixture.invalid', Tags.Language.Arabic).CreatePlugin(browser, HakuNeko.SettingsManager));
    const original = HakuNeko.PluginController.WebsitePlugins; HakuNeko.PluginController.WebsitePlugins = sites;
    const budget = await client.Request({ operation: 'queue-summary' });
    await SaveManualMediaList(sites[0].Identifier, Array.from({ length: 20492 }, (_, n) => ({ id: `m-${n}`, title: `Explorer Manga ${String(n).padStart(5,'0')}` })));
    await SaveManualMediaList(sites[1].Identifier, [{ id: 'm-0', title: 'Explorer Manga 00000' }]);
    const indexRepository = new SiteIndexRepository(), staleJob = await indexRepository.Start(['explorer-b']);
    const staleAttempt = await indexRepository.Begin(staleJob.id, 'explorer-b'); await indexRepository.Result(staleAttempt, 'catalog-fetch-or-storage-failed', false, false); await indexRepository.State(staleJob.id, 'finished');
    UI.page = 'arabic-manga'; UI.hubSection = 'explorer'; UI.explorerReference = undefined; UI.selectedItem = undefined;
    const target = document.createElement('div'); document.body.append(target); const app = mount(App, { target });
    const explorer = () => document.querySelector('[data-testid="library-explorer"]');
    await wait(() => explorer()?.querySelector('#explorer-site'));
    const choose = async id => { await wait(() => !explorer().querySelector('#explorer-site').disabled, 'site selector enabled'); const field = explorer().querySelector('#explorer-site'); field.value = id; field.dispatchEvent(new Event('change', { bubbles: true })); };
    await wait(() => explorer().querySelectorAll('#explorer-site option').length === 3);
    record('Explorer excludes connectors with no accepted nonempty local catalog', ![...explorer().querySelectorAll('#explorer-site option')].some(option => option.value === 'explorer-empty'));
    await SaveManualMediaList('explorer-new', [{ id: 'n', title: 'New saved manga' }]);
    await wait(() => [...explorer().querySelectorAll('#explorer-site option')].some(option => option.value === 'explorer-new'));
    record('A newly published local library appears without restarting Explorer or fetching the site', catalogs === 0);
    await choose('explorer-a'); await wait(() => explorer().querySelectorAll('.mangas article').length === 25);
    record('Explorer browses a 20492-entry local library with only 25 DOM rows and zero source requests', catalogs === 0 && lists === 0 && images === 0 && explorer().textContent.includes('20492'));
    record('A failed refresh retains the previous accepted library in the Explorer selector', [...explorer().querySelectorAll('#explorer-site option')].some(option => option.value === 'explorer-b'));
    await SaveManualMediaList('explorer-a', Array.from({ length: 20493 }, (_, n) => ({ id: `m-${n}`, title: `Explorer Manga ${String(n).padStart(5,'0')}` })));
    await wait(() => explorer().textContent.includes('20493 titles'));
    const librarySearch = explorer().querySelector('#explorer-search'); librarySearch.value = '00000'; librarySearch.dispatchEvent(new Event('input', { bubbles: true })); await wait(() => explorer().querySelectorAll('.mangas article').length === 1);
    record('Accepted library revisions refresh an empty-query browse and the shared search filters locally without source requests', catalogs === 0 && lists === 0 && images === 0);
    librarySearch.value = ''; librarySearch.dispatchEvent(new Event('input', { bubbles: true })); await wait(() => explorer().querySelectorAll('.mangas article').length === 25);
    const mangaRef = { siteId: sites[0].Identifier, siteName: sites[0].Title, mangaId: 'm-0', title: 'Explorer Manga 00000' };
    explorer().querySelector('.mangas article input').click(); await wait(() => !!cart.Find(mangaRef));
    record('Selecting a manga creates one symbolic all-chapters cart entry without loading chapters', lists === 0 && !cart.Find(mangaRef).chapters);
    explorer().querySelector('.mangas article input').click(); await wait(() => !cart.Find(mangaRef));
    record('The same manga checkbox removes its symbolic selection without opening the cart', !explorer().querySelector('[data-testid=selection-cart]'));
    explorer().querySelector('.mangas article input').click(); await wait(() => !!cart.Find(mangaRef));
    await wait(() => !explorer().querySelector('.mangas article button').disabled, 'manga action enabled');
    explorer().querySelector('.mangas article button').click(); await wait(() => explorer().querySelectorAll('.chapters article').length === 3);
    await wait(() => !explorer().querySelector('.chapters article input').disabled);
    explorer().querySelectorAll('.chapters article input')[1].click(); await wait(() => cart.Find(mangaRef)?.mode === 'except');
    record('Excluding one native chapter gives a durable partial 2/3 selection by original identity', cart.Find(mangaRef).ids.join(',') === '2' && explorer().querySelector('.mangas article input').indeterminate);
    const previousSearch = GetLocalSearchController().State.Value.preference.query;
    await choose('explorer-b'); await wait(() => explorer().querySelectorAll('.mangas article').length === 1); explorer().querySelector('.mangas article input').click();
    await wait(() => cart.State.Value.items.some(item => item.siteId === 'explorer-b'));
    await choose('explorer-a'); await wait(() => explorer().querySelectorAll('.mangas article').length === 25);
    record('Changing sites keeps shared selections and does not overwrite the independent Search query', cart.Find(mangaRef).ids[0] === '2' && GetLocalSearchController().State.Value.preference.query === previousSearch);
    await wait(() => !explorer().querySelector('.mangas article button').disabled, 'manga action enabled');
    explorer().querySelector('.mangas article button').click(); await wait(() => explorer().querySelectorAll('.chapters article').length === 3);
    record('The native Explorer test window is visible before viewport-based image loading', await ipcRenderer.invoke('ArchiveHubTest::Capture'));
    await wait(() => !explorer().querySelector('.chapters article button').disabled, 'preview action enabled');
    explorer().querySelector('.chapters article button').click(); await wait(() => explorer().querySelector('[data-testid=chapter-preview]'), 'inline preview mounted');
    await wait(() => images > 0, 'visible preview image fetch');
    const firstImageCount = images;
    explorer().querySelectorAll('.chapters article button')[1].click(); await wait(() => images > firstImageCount, 'replacement preview image fetch');
    record('Original image fetching previews successive chapters on the right while manga and chapter lists stay visible and selections stay intact', explorer().querySelectorAll('.mangas article').length === 25 && explorer().querySelectorAll('.chapters article').length === 3 && cart.Find(mangaRef).ids[0] === '2' && UI.selectedItem === undefined);
    const paneRects = [...explorer().querySelectorAll('.panes > section')].map(element => element.getBoundingClientRect());
    record('Desktop Explorer has three nonoverlapping columns with the preview to the right', paneRects.length === 3 && paneRects[0].right <= paneRects[1].left && paneRects[1].right <= paneRects[2].left);
    await ipcRenderer.invoke('ArchiveHubTest::Capture');
    const chapterFilter = explorer().querySelector('[aria-label="Search chapters"]'); chapterFilter.value = 'Chapter 2'; chapterFilter.dispatchEvent(new Event('input', { bubbles: true })); await tick();
    record('Chapter filtering preserves stable exclusions', explorer().querySelectorAll('.chapters article').length === 1 && cart.Find(mangaRef).ids[0] === '2');
    chapterFilter.value = ''; chapterFilter.dispatchEvent(new Event('input', { bubbles: true })); await tick();
    // One chapter, then zero selected must remove the manga rather than show a partial checkbox.
    explorer().querySelectorAll('.mangas article button')[1].click(); await wait(() => explorer().querySelectorAll('.chapters article').length === 1);
    await wait(() => ![...explorer().querySelectorAll('.selection-actions button')].find(button => button.textContent === 'Select All').disabled);
    [...explorer().querySelectorAll('.selection-actions button')].find(button => button.textContent === 'Select All').click();
    const single = { ...mangaRef, mangaId: 'm-1' }; await wait(() => !!cart.Find(single));
    await wait(() => !explorer().querySelector('.chapters article input').disabled); explorer().querySelector('.chapters article input').click(); await wait(() => !cart.Find(single));
    record('Deselecting the only chapter removes the SQLite cart entry and clears the manga checkbox', !explorer().querySelectorAll('.mangas article input')[1].checked && !explorer().querySelectorAll('.mangas article input')[1].indeterminate);
    await wait(() => !explorer().querySelector('.mangas article button').disabled, 'manga action enabled');
    explorer().querySelector('.mangas article button').click(); await wait(() => explorer().querySelectorAll('.chapters article').length === 3);
    [...explorer().querySelectorAll('.selection-actions button')].find(button => button.textContent === 'Clear Selection').click(); await wait(() => !cart.Find(mangaRef));
    record('Clear Selection removes the whole manga scope and clears its checkbox without affecting other sources', !explorer().querySelector('.mangas article input').checked && cart.State.Value.items.some(item => item.siteId === 'explorer-b'));
    await wait(() => ![...explorer().querySelectorAll('.selection-actions button')].find(button => button.textContent === 'Select All').disabled);
    [...explorer().querySelectorAll('.selection-actions button')].find(button => button.textContent === 'Select All').click(); await wait(() => cart.Find(mangaRef)?.mode === 'all');
    explorer().querySelectorAll('.chapters article input')[1].click(); await wait(() => cart.Find(mangaRef)?.mode === 'except');
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
