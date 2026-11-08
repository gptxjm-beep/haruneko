(async () => {
    await import('/src/engine/ArrayExtensions.ts'); // Registered by the real engine bootstrap; required by native pagination.
    const { Respond, Requests } = await import('/@id/__x00__arabic-priority-transport');
    const { default: MangaTek } = await import('/src/engine/websites/MangaTek.ts');
    const { default: MangaLover } = await import('/src/engine/websites/MangaLover.ts');
    const { Manga, Chapter } = await import('/src/engine/providers/MangaPlugin.ts');
    const { DownloadManager } = await import('/src/engine/DownloadManager.ts');
    const { EnqueueArchiveChapter } = await import('/src/engine/archive/ArchiveDownload.ts');
    const { ArchiveManager } = await import('/src/engine/archive/ArchiveManager.ts');
    const { DiagnoseChapterImage } = await import('/src/engine/ImageDiagnostics.ts');
    const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts');
    const { Priority } = await import('/src/engine/taskpool/DeferredTask.ts');
    const { FetchConcealedRequest } = await import('/src/engine/platform/FetchConcealedRequest.ts');
    // Use the same Request wrapper as production Electron; the fixture transport never sends these headers over a network.
    globalThis.Request = FetchConcealedRequest;
    const checks = [];
    const record = (name, passed) => { if (!passed) throw new Error(name); checks.push({ name, passed }); console.log(name, passed); };
    const canvas = new OffscreenCanvas(20, 2000); canvas.getContext('2d').fillRect(0, 0, 20, 2000);
    const image = await canvas.convertToBlob({ type: 'image/png' });
    const temporary = new Map();
    const storage = { SaveTemporary: async data => { const id = crypto.randomUUID(); temporary.set(id, data); return id; }, LoadTemporary: async id => temporary.get(id), RemoveTemporary: async (...ids) => ids.forEach(id => temporary.delete(id)), LoadPersistent: async () => undefined, SavePersistent: async () => {} };
    const make = (scraper, mangaId, title) => {
        const site = scraper.CreatePlugin(storage, HakuNeko.SettingsManager);
        const manga = new Manga(scraper, site, mangaId, title);
        const chapter = new Chapter(scraper, manga, '/fixture/priority/chapter/', 'Priority chapter');
        return { scraper, site, manga, chapter };
    };
    const tek = make(new MangaTek(), '/manga/priority/', 'Priority MangaTek');
    Respond('https://mangatek.com/fixture/priority/chapter/', { body: `<div class="manga-page"><img src="/fixture/1.png"><img data-src="/fixture/2.png" src="/placeholder.gif"><img data-lazy-src="/fixture/3.png" src="data:image/gif;base64,AA=="><img srcset="/fixture/4-small.png 480w, /fixture/4.png 1600w"></div>` });
    for (let index = 1; index <= 4; index++) Respond(`https://mangatek.com/fixture/${index}.png`, { body: image, type: index > 2 ? 'text/html' : 'image/png' });
    const pages = await tek.scraper.FetchPages(tek.chapter);
    record('Real DOM extraction returns all four MangaTek pages in order, including lazy and srcset pages', pages.map(page => page.Link.pathname).join(',') === '/fixture/1.png,/fixture/2.png,/fixture/3.png,/fixture/4.png');
    for (const page of pages) {
        const decoded = await page.Fetch(Priority.Normal, new AbortController().signal);
        record(`MangaTek fixture page ${page.Link.pathname} is validated from its actual PNG bytes`, decoded.type === 'image/png');
    }
    const diagnostic = await DiagnoseChapterImage(tek.chapter, 3, new AbortController().signal);
    record('Safe diagnostics use the real decoder once and record status, signature and dimensions without URLs', diagnostic.stage === 'complete' && diagnostic.httpStatus === 200 && diagnostic.signature === 'png' && diagnostic.width === 20 && diagnostic.height === 2000 && !JSON.stringify(diagnostic).includes('https:'));
    const picture = await createImageBitmap(await pages[2].Fetch(Priority.Normal, new AbortController().signal));
    record('Tall narrow fixture preserves its intrinsic 20 by 2000 pixel dimensions independently of MIME', picture.width === 20 && picture.height === 2000); picture.close();
    const { mount, unmount, tick } = await import('/@id/svelte');
    const { default: ImageViewer } = await import('/src/frontend/classic/components/viewer/ImageViewer.svelte');
    await tek.chapter.Update();
    const target = document.createElement('div'); target.style.cssText = 'width:600px;height:400px'; document.body.append(target);
    const viewer = mount(ImageViewer, { target, props: { item: tek.chapter, currentImageIndex: -1, wide: false, onNextItem() {}, onPreviousItem() {}, onClose() {} } });
    await tick();
    const deadline = Date.now() + 10000;
    while (![...target.querySelectorAll('img')].some(img => img.naturalHeight === 2000)) {
        if (Date.now() > deadline) throw new Error('Local viewer image did not load');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const shown = target.querySelector('img');
    record('Classic thumbnail viewer fits the tall fixture with contain rather than stretching its pixels', getComputedStyle(shown).objectFit === 'contain' && shown.naturalWidth === 20 && shown.naturalHeight === 2000);
    await unmount(viewer); target.remove();
    record('Image requests retain the chapter Referer', Requests().filter(request => request.path.endsWith('.png')).every(request => request.referer === 'https://mangatek.com/fixture/priority/chapter/'));
    const lover = make(new MangaLover(), JSON.stringify({ post: 'local', slug: '/manga/priority/' }), 'Priority Lover');
    Respond('https://3asq.online/fixture/priority/chapter/', { body: '<div class="page-break"><img srcset="https://bleach-fixture.invalid/low.png 1x, https://bleach-fixture.invalid/full.png 2x"><img data-src="https://abyss-fixture.invalid/full.png"></div>' });
    Respond('https://bleach-fixture.invalid/full.png', { body: '<html>Fixture unavailable</html>', type: 'image/png' });
    Respond('https://abyss-fixture.invalid/full.png', { body: image, type: 'application/octet-stream', finalUrl: 'https://redirect-fixture.invalid/full.png' });
    const mixed = await lover.scraper.FetchPages(lover.chapter);
    let invalid = false; try { await mixed[0].Fetch(Priority.Normal, new AbortController().signal); } catch { invalid = true; }
    record('HTML from one synthetic image host is rejected despite an image MIME', invalid);
    record('A separate synthetic image host with incorrect MIME and a simulated redirect remains decodable', (await mixed[1].Fetch(Priority.Normal, new AbortController().signal)).type === 'image/png');
    Respond('https://bleach-fixture.invalid/full.png', { body: '<html>Forbidden fixture</html>', status: 403 });
    let denied = false; try { await mixed[0].Fetch(Priority.Normal, new AbortController().signal); } catch { denied = true; }
    record('The existing response validator rejects a synthetic HTTP 403 without any alternate access attempt', denied);
    const blockedDiagnostic = await DiagnoseChapterImage(lover.chapter, 1, new AbortController().signal);
    record('Safe diagnostics retain HTTP 403 and the fetch stage without recording the restricted response body', blockedDiagnostic.httpStatus === 403 && blockedDiagnostic.error === 'access-restricted' && blockedDiagnostic.signature === null && blockedDiagnostic.bytes === null);
    Respond('https://3asq.online/manga/priority/ajax/chapters/', { body: `<ul>${Array.from({ length: 364 }, (_, index) => `<li class="wp-manga-chapter"><a href="https://3asq.online/manga/priority/${364 - index}/">${364 - index}</a></li>`).join('')}</ul>` });
    const chapters = await lover.scraper.FetchChapters(lover.manga);
    record('Real AJAX HTML extraction retains all 364 available chapter links in newest-first order', chapters.length === 364 && chapters[0].Identifier.endsWith('/364/') && chapters.at(-1).Identifier.endsWith('/1/'));
    const { EngineArchiveSource } = await import('/src/engine/archive/ArchiveSource.ts');
    const manifest = await new EngineArchiveSource(lover.site).Chapters(lover.manga, new AbortController().signal);
    record('The real 3asq engine adapter retains all fixture chapters and reports unknown order and source completeness', manifest.chapters.length === 364 && manifest.order === 'unknown' && manifest.coverage.state === 'unknown');
    Respond('https://3asq.online/manga/priority/ajax/chapters/', { body: '<ul><li class="wp-manga-chapter"><a href="https://3asq.online/manga/priority/299/">299</a></li></ul>' });
    record('A sparse chapter number does not invent a larger source list', (await lover.scraper.FetchChapters(lover.manga)).length === 1);
    // A cancelled page request releases its pool worker; retry is a new independent request.
    Respond('https://mangatek.com/fixture/1.png', { body: image, type: 'image/png', delayMs: 500 });
    const cancellation = new AbortController();
    const beforeCancellation = Requests().length;
    const cancelled = pages[0].Fetch(Priority.Normal, cancellation.signal).then(() => false, () => true);
    const cancellationDeadline = Date.now() + 2000;
    while (Requests().length === beforeCancellation) { if (Date.now() > cancellationDeadline) throw new Error('Local request did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
    cancellation.abort(new Error('Local test cancellation'));
    record('Cancellation rejects the owned in-flight image request', await cancelled);
    Respond('https://mangatek.com/fixture/1.png', { body: image, type: 'image/png' });
    record('A fresh image request succeeds after cancellation', (await pages[0].Fetch(Priority.Normal, new AbortController().signal)).type === 'image/png');
    const client = new ArchiveClient(); const grant = await client.Request({ operation: 'choose-root' });
    const settings = { format: 'image/*', useWebsiteSubDirectory: true };
    const manager = new DownloadManager(storage);
    const sessionId = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: tek.site.Identifier, siteName: tek.site.Title, settings });
    const registration = { siteId: tek.site.Identifier, mangaId: tek.manga.Identifier, chapterId: tek.chapter.Identifier, title: tek.chapter.Title, position: 0, orderConfidence: 'connector-contract', orderEvidence: 'Isolated fixture', expectedPages: 4, expectedPagesTrusted: true, expectedPagesEvidence: 'Local fixture definition, not a live-source proof' };
    const submitted = await EnqueueArchiveChapter(manager, client, sessionId, tek.chapter, registration);
    const result = await submitted.handle.completion;
    record('Corrected connector pages export through the original DownloadManager with four verified pages', result.outcome === 'succeeded' && result.inputValidation.validatedPages === 4 && result.output.files.length === 4);
    const archiveId = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: tek.site.Identifier, siteName: tek.site.Title, settings });
    const source = { site: tek.site, Catalog: async function* () { yield { items: [{ id: tek.manga.Identifier, title: tek.manga.Title }], terminal: true, coverage: { state: 'unknown', evidence: 'Fixture observations only' } }; },
        Chapters: async () => ({ chapters: [{ id: tek.chapter.Identifier, title: tek.chapter.Title, position: 0, language: 'ar', expectedPages: 4, expectedPagesTrusted: true, expectedPagesEvidence: 'Local fixture' }], order: 'ascending', orderEvidence: 'Local fixture order', coverage: { state: 'unknown', evidence: 'No live proof' } }) };
    const archive = new ArchiveManager(tek.site, manager, client, archiveId, { maxMangas: 1, maxChapters: 2, maxAttempts: 1, delayMs: 100, retryDelayMs: 1000, languages: ['ar'], unknownLanguage: 'review' }, { source });
    const archived = await archive.Start();
    record('ArchiveManager reuses the verified connector output while retaining unknown source completeness', archived.counts.healthy === 1 && archived.index.state === 'unknown' && archived.state !== 'drained');
    const failedId = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: lover.site.Identifier, siteName: lover.site.Title, settings });
    Respond('https://bleach-fixture.invalid/full.png', { body: '<html>Not an image</html>', type: 'image/jpeg' });
    const failed = await EnqueueArchiveChapter(manager, client, failedId, lover.chapter, { ...registration, siteId: lover.site.Identifier, mangaId: lover.manga.Identifier, chapterId: lover.chapter.Identifier, expectedPages: 2 });
    const failure = await failed.handle.completion;
    record('A chapter with an HTML page cannot finish as a successful export', failure.outcome === 'failed' && failure.inputValidation.validatedPages < 2);
    // The real native 3asq scraper returns the same paginated list to manual and hub indexing.
    const { SiteIndexRepository } = await import('/src/engine/catalog/SiteIndexRepository.ts');
    const { SiteIndexManager } = await import('/src/engine/catalog/SiteIndexManager.ts');
    const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
    const { SettingsManager } = await import('/src/engine/SettingsManager.ts');
    const { Store } = await import('/src/engine/StorageController.ts');
    const browserStore = new StorageControllerBrowser(), catalogRepository = new SiteIndexRepository();
    const catalogSite = new MangaLover().CreatePlugin(browserStore, new SettingsManager(browserStore));
    catalogSite.Initialize = async () => {}; // Transport authorization/setup is isolated; the real scraper/pagination stays intact.
    const respondCatalog = blank => {
        for (let page = 1; page <= 5; page++) Respond(`https://3asq.online/manga/page/${page}/`, { body: Array.from({ length: Math.max(0, Math.min(100, 399 - (page - 1) * 100)) }, (_, i) => {
            const n = (page - 1) * 100 + i;
            return `<div class="page-item-detail"><div data-post-id="${n}"></div><div class="post-title"><h3><a href="https://3asq.online/manga/catalog-${n}/">${blank && n === 100 ? '' : `Catalog ${n}`}</a></h3></div></div>`;
        }).join('') });
    };
    const update = async () => {
        const indexer = new SiteIndexManager(catalogRepository, () => [{ id: catalogSite.Identifier, Catalog: signal => new EngineArchiveSource(catalogSite).Catalog(signal), Published: () => catalogSite.InvalidateMediaListCache() }], navigator.locks, { timeoutMs: 15000, delayMs: 1, retryMs: 1 });
        await indexer.Start(catalogSite.Identifier); const until = Date.now() + 15000;
        while (indexer.Activity.Value.owned) { if (Date.now() > until) throw new Error('Native catalog indexing did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
        const status = (await catalogRepository.Snapshot()).sites.find(site => site.siteId === catalogSite.Identifier);
        if (status?.state !== 'succeeded') throw new Error(`Native fixture catalog failed: ${JSON.stringify(status)}; activity: ${indexer.Activity.Value.error}`);
    };
    respondCatalog(true); await update();
    let catalog = await browserStore.LoadPersistent(Store.MediaLists, catalogSite.Identifier);
    record('Real 3asq pagination retains 398 searchable references past a blank title at position 101 instead of discarding the first 100', catalog.length === 398 && catalog.some(row => JSON.parse(row.id).post === '398'));
    respondCatalog(false); await catalogSite.Update();
    record('The original manual refresh saves all 399 real scraper references', (await browserStore.LoadPersistent(Store.MediaLists, catalogSite.Identifier)).length === 399);
    respondCatalog(true); await update();
    catalog = await browserStore.LoadPersistent(Store.MediaLists, catalogSite.Identifier);
    const catalogState = (await catalogRepository.Snapshot()).sites.find(site => site.siteId === catalogSite.Identifier);
    record('A later incomplete bulk refresh preserves the larger manual catalog and explicitly marks partial source coverage', catalog.length === 399 && catalogState.coverage.state === 'partial' && catalogState.state === 'succeeded');
    const { DownloadMangaDetails } = await import('/src/engine/archive/MangaDetails.ts');
    const detailSaves = [];
    const detailClient = new ArchiveClient(async command => {
        if (command.operation === 'queue-details-save') detailSaves.push(command);
        return { ok: true, value: command.operation === 'queue-details-inspect' ? { coverHealthy: false } : command.operation === 'ui-progress' ? { registeredChapters: 2 } : 'Partial' };
    });
    const detailsId = JSON.stringify({ post: '0', slug: '/manga/catalog-0/' });
    Respond('https://3asq.online/manga/catalog-0/', { body: '<meta property="og:title" content="Known manga"><meta property="og:description" content="Known description"><meta property="og:image" content="https://details-fixture.invalid/cover.png"><script type="application/ld+json">{"@type":"ComicSeries","alternateName":["ون بيس","One Piece"],"author":{"name":"Known author"}}</script>' });
    Respond('https://details-fixture.invalid/cover.png', { body: '<html>Unavailable</html>', type: 'image/png' });
    await DownloadMangaDetails(catalogSite, { seq: 999, siteId: catalogSite.Identifier, mangaId: detailsId, title: 'Known manga', siteName: catalogSite.Title, sessionId: failedId, scope: { mode: 'all' } }, detailClient, new AbortController().signal);
    record('Optional details retain available text and real aliases when a cover is HTML, independently of chapter outcomes', detailSaves[0].text.includes('Known description') && detailSaves[0].text.includes('Known author') && detailSaves[0].text.includes('ون بيس') && detailSaves[0].cover === undefined && detailSaves[0].partial === true && failure.outcome === 'failed');
    Respond('https://details-fixture.invalid/cover.png', { body: image, type: 'application/octet-stream' });
    await DownloadMangaDetails(catalogSite, { seq: 999, siteId: catalogSite.Identifier, mangaId: detailsId, title: 'Known manga', siteName: catalogSite.Title, sessionId: failedId, scope: { mode: 'all' } }, detailClient, new AbortController().signal);
    record('Optional covers use the shared image validator and correct signature-derived extension', detailSaves[1].cover?.length > 0 && detailSaves[1].extension === 'png' && !detailSaves[1].partial);
    respondCatalog(true); await update();
    record('Explicit source aliases persist in the canonical catalog after a full observation refresh', (await browserStore.LoadPersistent(Store.MediaLists, catalogSite.Identifier)).find(row => row.id === detailsId).aliases.includes('ون بيس'));
    const { ExtractMangaDetails } = await import('/src/engine/archive/MangaDetails.ts');
    const marketing = new DOMParser().parseFromString('<meta property="og:description" content="Visit our manga website"><div class="description-summary"><div class="summary__content">Actual story about the hero</div></div><div class="author-content">Author A</div>', 'text/html');
    const story = ExtractMangaDetails(marketing);
    record('Real story takes priority over site marketing while independent author fields survive', story.fields.Description === 'Actual story about the hero' && story.fields.Author === 'Author A');
    record('Structured optional metadata excludes download progress and preserves cover diagnostics', detailSaves[0].metadata?.diagnostics.cover === 'invalid-image' && !JSON.stringify(detailSaves[0].metadata).includes('Registered chapters'));
    const related = new DOMParser().parseFromString('<script type="application/ld+json">[{"@type":"Book","url":"https://3asq.online/manga/catalog-0/","alternateName":"Real alias"},{"@type":"Book","url":"https://3asq.online/manga/other/","alternateName":"Unrelated alias"}]</script>', 'text/html');
    record('Metadata aliases from a different linked work are never assigned to the chosen manga', ExtractMangaDetails(related, new URL('https://3asq.online/manga/catalog-0/')).aliases.join(',') === 'Real alias');
    const { default: MangaSpark } = await import('/src/engine/websites/MangaSpark.ts');
    const spark = new MangaSpark().CreatePlugin(browserStore, new SettingsManager(browserStore)); spark.Initialize = async () => {};
    Respond('https://sparkmanga.net/wp-admin/admin-ajax.php', { body: async request => {
        const page = Number(new URLSearchParams(await request.text()).get('page'));
        return Array.from({ length: Math.max(0, Math.min(250, 20492 - page * 250)) }, (_, i) => `<div class="page-item-detail"><div data-post-id="${page * 250 + i}"></div><div class="post-title"><h3><a href="https://sparkmanga.net/manga/fixture-${page * 250 + i}/">Fixture ${page * 250 + i}</a></h3></div></div>`).join('');
    } });
    let observed = 0, responseStatus;
    const sparkIndexer = new SiteIndexManager(catalogRepository, () => [{ id: spark.Identifier, ObserveProgress: listener => spark.ObserveCatalogProgress((count, status) => { observed += count; if (status) responseStatus = status; listener(count, status); }), Catalog: signal => new EngineArchiveSource(spark).Catalog(signal) }], navigator.locks, { timeoutMs: 20000, delayMs: 1, retryMs: 1 });
    await sparkIndexer.Start(); const sparkDeadline = Date.now() + 25000;
    while (sparkIndexer.Activity.Value.owned) { if (Date.now() > sparkDeadline) throw new Error('Synthetic MangaSpark catalog did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
    record('Native MangaSpark AJAX pagination publishes 20492 isolated titles and reports real page progress and HTTP status', observed === 20492 && responseStatus === 200 && (await browserStore.LoadPersistent(Store.MediaLists, spark.Identifier)).length === 20492);
    record('A full synthetic MangaSpark refresh still does not prove source completeness', (await catalogRepository.Snapshot()).sites.find(site => site.siteId === spark.Identifier).coverage.state === 'unknown');
    return checks;
})()
