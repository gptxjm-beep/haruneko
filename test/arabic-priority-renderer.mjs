(async () => {
    const { Respond, Requests } = await import('/@id/__x00__arabic-priority-transport');
    const { default: MangaTek } = await import('/src/engine/websites/MangaTek.ts');
    const { default: MangaLover } = await import('/src/engine/websites/MangaLover.ts');
    const { Manga, Chapter } = await import('/src/engine/providers/MangaPlugin.ts');
    const { DownloadManager } = await import('/src/engine/DownloadManager.ts');
    const { EnqueueArchiveChapter } = await import('/src/engine/archive/ArchiveDownload.ts');
    const { ArchiveManager } = await import('/src/engine/archive/ArchiveManager.ts');
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
    Respond('https://3asq.online/manga/priority/ajax/chapters/', { body: `<ul>${Array.from({ length: 364 }, (_, index) => `<li class="wp-manga-chapter"><a href="https://3asq.online/manga/priority/${364 - index}/">${364 - index}</a></li>`).join('')}</ul>` });
    const chapters = await lover.scraper.FetchChapters(lover.manga);
    record('Real AJAX HTML extraction retains all 364 available chapter links in newest-first order', chapters.length === 364 && chapters[0].Identifier.endsWith('/364/') && chapters.at(-1).Identifier.endsWith('/1/'));
    const { EngineArchiveSource } = await import('/src/engine/archive/ArchiveSource.ts');
    const manifest = await new EngineArchiveSource(lover.site).Chapters(lover.manga, new AbortController().signal);
    record('The real 3asq engine adapter retains all fixture chapters and still reports unknown source completeness', manifest.chapters.length === 364 && manifest.order === 'descending' && manifest.coverage.state === 'unknown');
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
    return checks;
})()
