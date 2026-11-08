// Real Classic controls -> SQLite -> original ArchiveManager -> DownloadManager -> verified files.
(async () => {
    const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts');
    const { GetSelectiveQueueController, QueueIdentity } = await import('/src/engine/archive/SelectiveQueueController.ts');
    const { GetSelectiveQueueRunner } = await import('/src/engine/archive/SelectiveQueueRunner.ts');
    const { GetLocalSearchController } = await import('/src/engine/search/LocalSearchController.ts');
    const { SaveManualMediaList } = await import('/src/engine/catalog/SiteIndexRepository.ts');
    const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
    const { MangaScraper, Chapter, Page } = await import('/src/engine/providers/MangaPlugin.ts');
    const { DownloadManager } = await import('/src/engine/DownloadManager.ts');
    const { Tags } = await import('/src/engine/Tags.ts');
    const { Store: UI } = await import('/src/frontend/classic/stores/Stores.svelte.ts');
    const { default: App } = await import('/src/frontend/classic/App.svelte');
    const { mount, unmount, tick } = await import('/@id/svelte');
    const checks = [], client = new ArchiveClient(), queue = GetSelectiveQueueController();
    const searchController = GetLocalSearchController(); await searchController.Initialize(); const originalPreference = structuredClone(searchController.State.Value.preference);
    const record = (name, passed) => { if (!passed) throw new Error(name); checks.push({ name, passed }); console.log(name, passed); };
    const wait = async predicate => { const end = Date.now() + 25000; while (!await predicate()) { if (Date.now() > end) throw new Error('Queue timeout: ' + document.body.innerText.slice(-2500)); await new Promise(resolve => setTimeout(resolve, 30)); } };
    const click = async text => { const button = [...document.querySelectorAll('button,a')].find(el => el.textContent.trim() === text && el.checkVisibility()); if (!button) throw new Error('Missing queue action ' + text); await wait(() => !button.disabled); button.click(); await tick(); };
    const input = async value => { const el = document.querySelector('[data-testid="shared-search-query"]'); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); await tick(); await wait(() => GetLocalSearchController().State.Value.status === 'ready'); };
    const canvas = new OffscreenCanvas(2, 2); canvas.getContext('2d').fillRect(0, 0, 2, 2); const image = await canvas.convertToBlob({ type: 'image/png' });
    let images = 0, catalogs = 0, release;
    let gate = new Promise(resolve => { release = resolve; }); const order = [];
    class Fixture extends MangaScraper {
        async Initialize() {}
        async FetchMangas() { catalogs++; throw new Error('Queue must not enumerate whole sites'); }
        GetArchiveChapterOrder(manga) { return ['unknown', 'preview15'].includes(manga.Identifier) ? { order: 'unknown', evidence: 'Fixture has no proven order' } : { order: 'descending', evidence: 'Isolated fixture explicitly emits newest then oldest after decorators' }; }
        async FetchChapters(manga) { if (manga.Identifier === 'preview15') return Array.from({ length: 15 }, (_, n) => new Chapter(this, manga, String(15 - n), `Chapter ${15 - n}`)); return [new Chapter(this, manga, 'new', 'Chapter New'), new Chapter(this, manga, 'old', 'Chapter Old')]; }
        async FetchPages(chapter) { return [new Page(this, chapter, new URL('https://fixture.invalid/page'))]; }
        async FetchImage(page, _priority, signal) { images++; order.push([page.Parent.Parent.Identifier, page.Parent.Identifier]); await gate; signal.throwIfAborted(); return page.Parent.Parent.Identifier === 'bad' ? new Blob(['<html>Error</html>'], { type: 'image/png' }) : image; }
    }
    const temporary = new Map(), browser = new StorageControllerBrowser();
    const storage = { LoadPersistent: (...args) => browser.LoadPersistent(...args), SavePersistent: (...args) => browser.SavePersistent(...args), SaveTemporary: async data => { const key = crypto.randomUUID(); temporary.set(key, data); return key; }, LoadTemporary: async key => temporary.get(key), RemoveTemporary: async (...keys) => keys.forEach(key => temporary.delete(key)) };
    const a = new Fixture('queue-a', 'Queue source A', 'https://fixture.invalid', Tags.Language.Arabic).CreatePlugin(storage, HakuNeko.SettingsManager);
    const b = new Fixture('queue-b', 'Queue source B', 'https://fixture.invalid', Tags.Language.Arabic).CreatePlugin(storage, HakuNeko.SettingsManager);
    const originalSites = HakuNeko.PluginController.WebsitePlugins, originalDownloads = HakuNeko.DownloadManager;
    HakuNeko.PluginController.WebsitePlugins = [a, b]; HakuNeko.DownloadManager = new DownloadManager(storage); const runner = GetSelectiveQueueRunner();
    const refs = [{ siteId: a.Identifier, mangaId: 'one', title: 'One Piece Queue', siteName: a.Title }, { siteId: b.Identifier, mangaId: 'bleach', title: 'Bleach Queue', siteName: b.Title }, { siteId: a.Identifier, mangaId: 'berserk', title: 'Berserk Queue', siteName: a.Title }];
    await SaveManualMediaList(a.Identifier, refs.filter(ref => ref.siteId === a.Identifier).map(ref => ({ id: ref.mangaId, title: ref.title })));
    await SaveManualMediaList(b.Identifier, [{ id: 'bleach', title: 'Bleach Queue' }]);
    UI.page = 'arabic-manga'; UI.hubSection = 'search'; UI.selectedPlugin = undefined; UI.selectedMedia = undefined;
    const target = document.createElement('div'); document.body.append(target); const app = mount(App, { target });
    await wait(() => document.querySelector('[data-testid="shared-search-query"]') && !document.querySelector('[data-testid="shared-search-query"]').disabled);
    for (const query of ['One Piece Queue', 'Bleach Queue']) {
        await input(query); const checkbox = document.querySelector('[data-testid="shared-search-result"] input[type=checkbox]'); checkbox.click(); await wait(async () => (await client.Request({ operation: 'queue-summary' })).selected === (query.startsWith('One') ? 1 : 2));
    }
    await input('Berserk Queue'); await click('Add to Queue'); await wait(async () => (await queue.List()).length === 1);
    record('Selections persist across different searches and sources while direct addition is independent', (await queue.Selections()).map(ref => ref.mangaId).join(',') === 'one,bleach' && (await queue.List())[0].mangaId === 'berserk');
    await wait(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Saved selections (2)'));
    await click('Saved selections (2)');
    await wait(() => document.querySelectorAll('[data-testid="personal-selections"] [data-testid="personal-entry"]').length === 2);
    record('Saved selections open inside Search without replacing its query or data', UI.hubSection === 'search' && document.querySelector('[data-testid="shared-search-query"]').value === 'Berserk Queue' && (await queue.Selections()).length === 2);
    await click('Saved selections (2)');
    await click('Add Selected to Queue'); await wait(async () => (await queue.List()).length === 3);
    await queue.Add(refs[0]);
    record('Bulk and individual additions share one queue, preserve first selection order and never start a download', (await queue.List()).map(ref => ref.mangaId).join(',') === 'berserk,one,bleach' && images === 0 && catalogs === 0);
    await input('One Piece Queue'); await wait(() => document.querySelector('[data-testid="shared-search-result"] input').checked);
    record('Returning to a previous search distinguishes independent selection and queue membership', queue.State.Value.flags[QueueIdentity(refs[0])] === true && document.querySelector('[data-testid="shared-search-result"]').textContent.includes('Added to downloads'));
    await SaveManualMediaList(a.Identifier, [{ id: 'berserk', title: 'Berserk Queue' }]);
    UI.hubSection = 'selections'; await tick();
    await wait(() => document.querySelector('[data-testid="personal-selections"]')?.textContent.includes('missing from the current catalog'));
    record('A disappeared accepted reference is retained in selection review with a warning', (await queue.Selections()).length === 2);
    let releasePreviewCache, previewCacheCaptured = false, previewCacheFinished = false;
    const previewCacheGate = new Promise(resolve => { releasePreviewCache = resolve; });
    const originalPreviewLoad = StorageControllerBrowser.prototype.LoadPersistent;
    StorageControllerBrowser.prototype.LoadPersistent = async function(store, key) {
        const value = await originalPreviewLoad.call(this, store, key);
        if (key === 'arabic-chapters:["queue-b","bleach"]') { previewCacheCaptured = true; await previewCacheGate; previewCacheFinished = true; }
        return value;
    };
    UI.hubSection = 'queue'; await tick(); await wait(() => document.querySelector('[data-testid="personal-queue"]'));
    let rows = await queue.List(); await queue.Edit(rows[2].seq, 'up'); rows = await queue.List();
    record('Queue priority can change without changing stable manga identities', rows.map(row => row.mangaId).join(',') === 'berserk,bleach,one');
    await wait(() => [...document.querySelectorAll('[data-testid="personal-entry"]')].some(entry => entry.textContent.includes('Bleach Queue')));
    const bleachCard = () => [...document.querySelectorAll('[data-testid="personal-entry"]')].find(entry => entry.textContent.includes('Bleach Queue'));
    await wait(() => previewCacheCaptured);
    await wait(() => ![...bleachCard().querySelectorAll('button')].find(button => button.textContent.startsWith('Chapters (')).disabled);
    [...bleachCard().querySelectorAll('button')].find(button => button.textContent.startsWith('Chapters (')).click();
    await wait(() => bleachCard().querySelectorAll('.chapter-list input').length === 2);
    record('Chapter expansion fetches names only and selects all stable identities by default', images === 0 && [...bleachCard().querySelectorAll('.chapter-list input')].every(input => input.checked));
    releasePreviewCache(); StorageControllerBrowser.prototype.LoadPersistent = originalPreviewLoad;
    await wait(() => previewCacheFinished); await new Promise(resolve => setTimeout(resolve, 0)); await tick();
    record('A late empty preview cache cannot overwrite a freshly fetched chapter list', bleachCard().querySelectorAll('.chapter-list input').length === 2);
    const chapterOrder = bleachCard().querySelector('.chapter-policy > label select'); chapterOrder.value = 'first-last'; chapterOrder.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(async () => (await queue.List()).find(row => row.mangaId === 'bleach').scope.order === 'first-last');
    await wait(() => bleachCard().querySelector('.chapter-list span').textContent === 'Chapter Old');
    bleachCard().querySelector('.chapter-list input').click();
    await wait(async () => (await queue.List()).find(row => row.mangaId === 'bleach').scope.mode === 'selected');
    record('Individual chapter selection is durable by ID and chronological display follows the same policy', (await queue.List()).find(row => row.mangaId === 'bleach').scope.ids.join(',') === 'new');
    await click('Clear Selection');
    await wait(async () => (await queue.List()).find(row => row.mangaId === 'bleach').scope.ids?.length === 0);
    await wait(() => [...bleachCard().querySelectorAll('.chapter-list input')].every(input => !input.checked));
    const chaptersToggle = () => [...bleachCard().querySelectorAll('button')].find(button => button.textContent.startsWith('Chapters ('));
    chaptersToggle().click(); await tick(); chaptersToggle().click();
    await wait(() => bleachCard().querySelectorAll('.chapter-list input').length === 2);
    record('Clear Selection saves zero IDs across closing and reopening the real Svelte panel without IPC clone errors', [...bleachCard().querySelectorAll('.chapter-list input')].every(input => !input.checked));
    await click('Select All');
    await wait(async () => (await queue.List()).find(row => row.mangaId === 'bleach').scope.mode === 'all');
    await wait(() => [...bleachCard().querySelectorAll('.chapter-list input')].every(input => input.checked));
    bleachCard().scrollIntoView({ block: 'center' });
    await ipcRenderer.invoke('QueueTest::Capture');
    const oneRow = (await queue.List()).find(row => row.mangaId === 'one'); await queue.Edit(oneRow.seq, 'up', { mode: 'all', order: 'first-last' });
    await queue.Edit(rows[0].seq, 'up', { mode: 'range', from: 1, to: 1 });
    const oldReference = { siteId: a.Identifier, mangaId: 'readded-later', title: 'Old removed queue identity', siteName: a.Title };
    await queue.Add(oldReference); const oldRow = (await queue.List()).find(row => row.mangaId === oldReference.mangaId); await queue.Edit(oldRow.seq, 'remove');
    for (const [mangaId, title] of [['unknown', 'Unknown Order Queue'], ['bad', 'Invalid Image Queue'], ['extra', 'Over Budget Queue']]) await queue.Add({ siteId: a.Identifier, mangaId, title, siteName: a.Title });
    const grant = await client.Request({ operation: 'choose-root' }), defaults = await client.Request({ operation: 'ui-preferences' });
    await click('Start Downloads / Resume…'); await wait(() => document.querySelector('[data-testid="queue-setup"]'));
    record('The actual queue UI accurately explains equivalent All and Missing and the SQLite downgrade restriction', document.querySelector('[data-testid="queue-scope-notice"]').textContent.includes('All and Missing currently use the same') && document.querySelector('[data-testid="personal-queue"]').textContent.includes('SQLite v10'));
    record('Start requires an explicit setup confirmation and exposes the frozen development limits', [...document.querySelectorAll('[data-testid="queue-setup"] button')].find(button => button.textContent.trim() === 'Start Downloads').disabled && document.querySelector('[data-testid="queue-budget"]').textContent.includes('/20'));
    // Edit only this queue's setup. General archiving and manual download defaults must remain untouched.
    for (const [label, value] of [['Delay between requests', '100'], ['Retry delay', '1000'], ['Maximum attempts', '1'], ['Languages', 'ar']]) {
        const field = [...document.querySelectorAll('[data-testid="queue-setup"] label')].find(element => element.textContent.trim().startsWith(label)).querySelector('input');
        field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const websiteFolder = [...document.querySelectorAll('[data-testid="queue-setup"] label')].find(element => element.textContent.includes('Create a separate website folder')).querySelector('input');
    if (!websiteFolder.checked) websiteFolder.click();
    await tick();
    // The form contains other checkboxes; select the explicit confirmation by its label.
    const explicit = [...document.querySelectorAll('[data-testid="queue-setup"] label')].find(label => label.textContent.includes('Start this limited run')).querySelector('input'); explicit.click(); await tick(); await wait(() => ![...document.querySelectorAll('[data-testid="queue-setup"] button')].find(button => button.textContent.trim() === 'Start Downloads').disabled); await click('Start Downloads');
    await wait(() => images === 1);
    const confirmedBatch = (await client.Request({ operation: 'queue-summary' })).batchId;
    await queue.Add({ siteId: a.Identifier, mangaId: 'late-addition', title: 'Added during first download', siteName: a.Title });
    await queue.Add(oldReference);
    record('New and old readded identities remain outside the confirmed batch while its first image is downloading', (await client.Request({ operation: 'queue-summary' })).waitingNextRun === 2 && (await queue.List()).filter(row => ['late-addition', 'readded-later'].includes(row.mangaId)).every(row => !row.inCurrentRun && !row.sessionId));
    await click('Pause'); release(); gate = Promise.resolve();
    await wait(async () => (await client.Request({ operation: 'queue-summary' })).state === 'Paused' && !runner.Running);
    const paused = await client.Request({ operation: 'queue-summary' });
    record('Pause finishes the owned chapter and persists its receipt and cumulative attempt budget', paused.chaptersStarted === 1 && order[0][0] === 'berserk' && order[0][1] === 'old');
    await click('Start Downloads / Resume…'); await wait(() => document.querySelector('[data-testid="queue-setup"]'));
    [...document.querySelectorAll('[data-testid="queue-setup"] label')].find(label => label.textContent.includes('Start this limited run')).querySelector('input').click(); await tick(); await wait(() => ![...document.querySelectorAll('[data-testid="queue-setup"] button')].find(button => button.textContent.trim() === 'Start Downloads').disabled); await click('Start Downloads');
    await wait(async () => (await client.Request({ operation: 'queue-summary' })).state === 'Limited' && !runner.Running);
    rows = await queue.List(); const summary = await client.Request({ operation: 'queue-summary' });
    record('Pause and resume retain original run membership and never start late additions or resurrect an old queue identity', summary.batchId === confirmedBatch && summary.waitingNextRun === 2 && rows.filter(row => ['late-addition', 'readded-later'].includes(row.mangaId)).every(row => row.state === 'Queued' && !row.sessionId));
    record('Selective execution uses the original managers and preserves oldest-first chapter order without read-state filtering', rows.slice(0, 3).every(row => row.state === 'Completed') && order.filter(([id]) => id === 'bleach').map(([, chapter]) => chapter).join(',') === 'old,new');
    record('Explicit default Source Order downloads unproven chronological lists in the displayed source sequence without asserting source completeness', rows.find(row => row.mangaId === 'unknown').state === 'Completed' && order.filter(([id]) => id === 'unknown').map(([, chapter]) => chapter).join(',') === 'new,old');
    record('HTML images cannot produce a Completed queue item', rows.find(row => row.mangaId === 'bad').state === 'Review');
    record('The cumulative five-manga limit leaves extra queued entries intact without hidden session resets', summary.mangasUsed === 5 && summary.chaptersStarted <= 20 && rows.find(row => row.mangaId === 'extra').state === 'Queued');
    const detailsItem = rows.find(row => row.state === 'Completed');
    const detailResult = await client.Request({ operation: 'queue-details-save', seq: detailsItem.seq, text: 'Known optional details', cover: new Uint8Array(await image.arrayBuffer()), extension: 'png', partial: false, metadata: { schema: 1, title: 'قصة محلية', sourceName: 'Test', fields: { Description: 'Known local story', Author: 'Known author' } } });
    const offline = await ipcRenderer.invoke('QueueTest::OfflineDetails');
    record('Native generated HTML opens offline with the saved cover and story, without external resource requests', offline.title === 'قصة محلية' && offline.text.includes('Known local story') && offline.width === 2 && offline.requests === 0);
    const detailsHealth = await client.Request({ operation: 'queue-details-inspect', seq: detailsItem.seq });
    record('Real native details publication saves a separate valid cover receipt without changing chapter completion or cumulative budget', detailResult === 'Saved' && detailsHealth.coverHealthy && (await queue.List()).find(row => row.seq === detailsItem.seq).state === 'Completed' && (await client.Request({ operation: 'queue-summary' })).chaptersStarted === summary.chaptersStarted);
    await client.Request({ operation: 'queue-details-save', seq: detailsItem.seq, text: 'Known optional details', cover: new TextEncoder().encode('<html>not an image</html>'), extension: 'png', partial: false });
    record('Native optional-cover validation rejects HTML while preserving the healthy cover and chapter receipts', (await client.Request({ operation: 'queue-details-inspect', seq: detailsItem.seq })).coverHealthy && (await queue.List()).find(row => row.seq === detailsItem.seq).state === 'Completed');
    const completed = rows[0], before = images; await queue.Edit(completed.seq, 'remove'); await queue.Add(refs[2]);
    const fresh = (await queue.List()).find(row => row.mangaId === 'berserk');
    record('Readding resets the selection while preserving historical receipts and budget', fresh.sessionId === null && fresh.scope.mode === 'all' && fresh.historyCount === 1);
    await queue.Edit(fresh.seq, 'up', { mode: 'selected', ids: ['old'], order: 'first-last' });
    await runner.Start(summary.preferences, true);
    const readded = (await queue.List()).find(row => row.mangaId === 'berserk');
    record('Removing and readding starts a fresh linked manifest and reuses physically healthy files without refetching', images === before && readded.state === 'Completed' && readded.sessionId !== completed.sessionId && readded.historyCount === 2);
    const report = await client.Request({ operation: 'queue-report', seq: readded.seq });
    record('Download Report retains both attempt histories and verified physical-file counts', report.sessions.length === 2 && report.sessions.every(session => session.counts.completed === 1 && session.history.length));
    const completedCard = () => [...document.querySelectorAll('[data-testid="personal-entry"]')].find(card => card.textContent.includes('Berserk Queue'));
    await wait(() => [...completedCard().querySelectorAll('button')].some(button => button.textContent.trim() === 'Download Report'));
    [...completedCard().querySelectorAll('button')].find(button => button.textContent.trim() === 'Download Report').click();
    await wait(() => completedCard().querySelector('[data-testid="download-report"]')?.textContent.includes('verified requested chapters'));
    record('The real Download Report panel opens current and historical verified chapter results without another source request', completedCard().querySelector('[data-testid="download-report"]').textContent.includes('Recorded history'));
    record('Native report export uses the save dialog and refuses to replace an existing exported file', await client.Request({ operation: 'queue-export-report', seq: readded.seq }));
    let exportProtected = false; try { await client.Request({ operation: 'queue-export-report', seq: readded.seq }); } catch { exportProtected = true; }
    record('Repeated report export preserves existing files', exportProtected);
    await ipcRenderer.invoke('QueueTest::RemoveIsolatedChapter');
    const diskAudit = await queue.Audit(readded.seq);
    record('An externally removed isolated chapter loses its Verified badge while immutable receipts and historical reports remain', diskAudit.some(row => row.localState === 'missing') && (await queue.List()).find(row => row.seq === readded.seq).state === 'Review' && (await queue.List()).find(row => row.seq === readded.seq).progress.verified === 0 && (await client.Request({ operation: 'queue-report', seq: readded.seq })).sessions.some(session => session.history.length));
    await runner.Cancel(); record('Cancel preserves the original manual download manager and does not delete completed references', originalDownloads.Queue.Value.length === 0 && (await queue.List()).some(row => row.state === 'Completed'));
    record('Selective setup and execution do not modify the existing archiving defaults', JSON.stringify((await client.Request({ operation: 'ui-preferences' })).preferences) === JSON.stringify(defaults.preferences));
    await queue.Add({ siteId: a.Identifier, siteName: a.Title, mangaId: 'preview15', title: 'Fifteen chapter preview' });
    await wait(() => [...document.querySelectorAll('[data-testid="personal-entry"]')].some(card => card.textContent.includes('Fifteen chapter preview')));
    const fifteenCard = () => [...document.querySelectorAll('[data-testid="personal-entry"]')].find(card => card.textContent.includes('Fifteen chapter preview'));
    const fifteenOrder = () => fifteenCard().querySelector('.chapter-policy > label select');
    await wait(() => !fifteenOrder().disabled);
    fifteenOrder().value = 'first-last'; fifteenOrder().dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => fifteenCard().textContent.includes('Order not applied yet'));
    record('Unknown source direction requires visible preview confirmation rather than a falsely saved chronological policy', (await queue.List()).find(row => row.mangaId === 'preview15').scope.order === 'source');
    const direction = fifteenCard().querySelector('.chapter-panel select'); direction.value = 'descending'; direction.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => fifteenCard().querySelector('.chapter-list span')?.textContent === 'Chapter 1');
    await wait(() => !fifteenOrder().disabled);
    fifteenOrder().value = 'last-first'; fifteenOrder().dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => fifteenCard().querySelector('.chapter-list span')?.textContent === 'Chapter 15');
    await wait(() => !fifteenOrder().disabled);
    fifteenOrder().value = 'first-last'; fifteenOrder().dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => fifteenCard().querySelector('.chapter-list span')?.textContent === 'Chapter 1');
    const clear = [...fifteenCard().querySelectorAll('button')].find(button => button.textContent.trim() === 'Clear Selection'); clear.click();
    await wait(() => [...fifteenCard().querySelectorAll('.chapter-list input')].every(input => !input.checked));
    for (const id of ['1','2','3']) {
        const input = [...fifteenCard().querySelectorAll('.chapter-list label')].find(label => label.querySelector('span').textContent === `Chapter ${id}`).querySelector('input');
        await wait(() => !input.disabled); input.click();
        await wait(async () => (await queue.List()).find(row => row.mangaId === 'preview15').scope.ids?.includes(id));
    }
    const row15 = (await queue.List()).find(row => row.mangaId === 'preview15');
    record('Real Svelte first-last and last-first previews pin all fifteen original identities, then save 1,2,3 without clone errors', row15.scope.direction === 'descending' && row15.scope.sourceIds[0] === '15' && row15.scope.ids.join(',') === '1,2,3');
    globalThis.selectiveQueueFixture = { selected: 2, queued: (await queue.List()).length, chaptersStarted: summary.chaptersStarted, chapterSelection: row15.seq };
    await unmount(app); target.remove(); HakuNeko.PluginController.WebsitePlugins = originalSites; HakuNeko.DownloadManager = originalDownloads; UI.hubSection = 'sites';
    searchController.Query(originalPreference, 0); searchController.SetActive(originalPreference.active); await searchController.Flush();
    return checks;
})()
