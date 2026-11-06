(async () => {
    const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts');
    const { EnqueueArchiveChapter } = await import('/src/engine/archive/ArchiveDownload.ts');
    const { DownloadManager } = await import('/src/engine/DownloadManager.ts');
    const { Manga, Chapter, Page } = await import('/src/engine/providers/MangaPlugin.ts');
    const client = new ArchiveClient();
    const checks = [];
    const record = (name, passed) => { console.log(name, passed); checks.push({ name, passed }); };
    const grant = await client.Request({ operation: 'choose-root' });
    record('Native root grant exposes an ID, not a path or FileSystemHandle', typeof grant.rootId === 'string' && !('path' in grant));
    const settings = { format: 'image/*', useWebsiteSubDirectory: true };
    const sessionId = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: 'site', siteName: 'Site', settings });
    globalThis.HakuNeko = { SettingsManager: { OpenScope() { throw new Error('Archive export accessed global download settings'); } } };
    const temporary = new Map();
    const storage = {
        SaveTemporary: async data => { const key = crypto.randomUUID(); temporary.set(key, data); return key; },
        LoadTemporary: async key => temporary.get(key),
        RemoveTemporary: async (...keys) => { for (const key of keys) temporary.delete(key); },
    };
    const canvas = new OffscreenCanvas(2, 2);
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const image = await canvas.convertToBlob({ type: 'image/png' });
    let fetched = 0;
    const scraper = {
        GetArchiveChapterOrder: () => ({ order: 'descending', evidence: 'Isolated fixture explicitly returns new then old' }),
        FetchPages: async chapter => [new Page(scraper, chapter, new URL('https://example.invalid/local-image'))],
        FetchImage: async () => { fetched++; return image; },
    };
    const plugin = { Identifier: 'site', Title: 'Site', storageController: storage, Initialize: async () => {}, IsSameAs: other => other.Identifier === 'site' };
    const manga = new Manga(scraper, plugin, 'manga', 'Manga');
    const chapter = new Chapter(scraper, manga, 'chapter', 'Chapter 1');
    const registration = { siteId: 'site', mangaId: 'manga', chapterId: 'chapter', title: 'Chapter 1', position: 0,
        orderConfidence: 'connector-contract', orderEvidence: 'Fixture source order', expectedPages: 1, expectedPagesTrusted: true, expectedPagesEvidence: 'Fixture one-page manifest v1' };
    const manager = new DownloadManager(storage);
    const submitted = await EnqueueArchiveChapter(manager, client, sessionId, chapter, registration);
    if (submitted.kind !== 'download') throw new Error('Expected first attempt to download');
    const result = await submitted.handle.completion;
    if (result.outcome !== 'succeeded') throw new Error(result.errors.map(item => `${item.stage}: ${item.error.message}`).join('; '));
    record('Original DownloadManager writes an archive through native IPC', result.outcome === 'succeeded');
    record('Native receipts have SHA-256 and no live file handle', result.verification.method === 'sha256' && /^[a-f0-9]{64}$/.test(result.output.files[0].sha256) && !result.output.files[0].handle);
    record('Selected archive root and relative paths are recorded', result.output.rootId === grant.rootId && result.output.files[0].path === 'Site/Manga/Chapter 1/1.png');
    record('Original temporary storage is cleaned', temporary.size === 0);
    const restored = await EnqueueArchiveChapter(manager, client, sessionId, chapter, registration);
    record('Resume reuses verified bytes without fetching the image again', restored.kind === 'reuse' && fetched === 1);
    const session = await client.Request({ operation: 'session', sessionId });
    record('Site completeness remains unknown', session.index_state === 'unknown');
    const nextSession = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: 'site', siteName: 'Site', settings });
    const reused = await EnqueueArchiveChapter(manager, client, nextSession, chapter, registration);
    record('New session preserves old files without asserting a fresh source proof', reused.kind === 'reuse' && reused.recovery.sourceState === 'unknown' && fetched === 1);
    const collision = new Chapter(scraper, manga, 'collision', 'Chapter 1');
    const conflict = await EnqueueArchiveChapter(manager, client, sessionId, collision, { ...registration, chapterId: 'collision' });
    const conflictResult = await conflict.handle.completion;
    record('A second identity cannot overwrite an existing chapter path', conflictResult.outcome === 'failed');
    const reviewed = await EnqueueArchiveChapter(manager, client, sessionId, collision, { ...registration, chapterId: 'collision' });
    record('An unresolved filename conflict requests review rather than automatic retry', reviewed.kind === 'review');
    const cancellation = new AbortController();
    cancellation.abort();
    const cancelledChapter = new Chapter(scraper, manga, 'cancelled', 'Cancelled');
    const before = fetched;
    const cancelled = await EnqueueArchiveChapter(manager, client, sessionId, cancelledChapter, { ...registration, chapterId: 'cancelled' }, { signal: cancellation.signal });
    record('Cancelled queued attempts are durable without fetching', (await cancelled.handle.completion).outcome === 'cancelled' && fetched === before);
    let denied = false;
    try { await client.Request({ operation: 'sql', sql: 'DROP TABLE roots' }); } catch { denied = true; }
    record('Renderer cannot execute arbitrary SQL', denied);
    for (const format of ['application/x-cbz', 'application/epub+zip', 'application/pdf']) {
        const exportSession = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: 'site', siteName: 'Site', settings: { ...settings, format } });
        const exported = await EnqueueArchiveChapter(manager, client, exportSession, chapter, registration);
        if (exported.kind !== 'download') throw new Error(`Expected independent ${format} export`);
        const exportedResult = await exported.handle.completion;
        if (exportedResult.outcome !== 'succeeded') throw new Error(exportedResult.errors.map(item => item.error.message).join('; '));
        record(`Native ${format} uses the original exporter and SHA-256 receipts`, exportedResult.verification.method === 'sha256' && exportedResult.output.files.length === 1);
    }
    const { ArchiveManager } = await import('/src/engine/archive/ArchiveManager.ts');
    const { EngineArchiveSource } = await import('/src/engine/archive/ArchiveSource.ts');
    plugin.CreateEntry = (id, title) => new Manga(scraper, plugin, id, title);
    plugin.Tags = { Value: [] };
    const visited = [];
    scraper.FetchChapters = async manga => ['new', 'old'].map(id => {
        const entry = new Chapter(scraper, manga, id, id === 'old' ? 'Decimal 1.5' : 'Special');
        entry.IsStored.Value = true; // Read/stored markers never exclude archive work.
        return entry;
    });
    scraper.FetchPages = async chapter => {
        visited.push(`${chapter.Parent.Identifier}/${chapter.Identifier}`);
        return [new Page(scraper, chapter, new URL('https://example.invalid/local-image'))];
    };
    const nativeSource = new EngineArchiveSource(plugin);
    const source = { site: plugin,
        Catalog: async function* () { yield { items: [{ id: 'manager-a', title: 'Manager A' }, { id: 'manager-b', title: 'Manager B' }], terminal: true,
            coverage: { state: 'complete', evidence: 'Isolated two-manga fixture manifest' } }; },
        Chapters: (manga, signal) => nativeSource.Chapters(manga, signal),
    };
    const coordinatorSession = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: 'site', siteName: 'Site', settings });
    const policy = { maxMangas: 2, maxChapters: 4, delayMs: 100, retryDelayMs: 1000, maxAttempts: 2, languages: [], unknownLanguage: 'include' };
    const firstCoordinator = new ArchiveManager(plugin, manager, client, coordinatorSession, policy, { source, beforeCapacity: async checkpoint => {
        if (checkpoint.phase === 'before-temporary-write') void firstCoordinator.Pause();
    } });
    record('Coordinator gracefully pauses after its first native chapter receipt', (await firstCoordinator.Start()).state === 'paused' && visited.length === 1);
    const resumed = new ArchiveManager(plugin, manager, client, coordinatorSession, policy, { source });
    const resumedState = await resumed.Resume();
    record('Coordinator resumes through SQLite and original DownloadManager without re-fetching healthy files', resumedState.counts.healthy === 4 && visited.length === 4);
    record('Coordinator processes each native manga oldest-first, including read-marked chapters', visited.join(',') === 'manager-a/old,manager-a/new,manager-b/old,manager-b/new');
    record('Native connector chapter-list uncertainty remains reviewable', resumedState.state === 'review');
    scraper.FetchChapters = async manga => Array.from({ length: 364 }, (_, index) => new Chapter(scraper, manga, `c${363 - index}`, `Chapter ${363 - index}`));
    const longSession = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: 'site', siteName: 'Site', settings });
    const longSource = { site: plugin,
        Catalog: async function* () { yield { items: [{ id: 'long-manager', title: 'Long Manager' }], terminal: true,
            coverage: { state: 'unknown', evidence: 'Isolated long-manga fixture' } }; },
        Chapters: (manga, signal) => nativeSource.Chapters(manga, signal),
    };
    const beforeLong = visited.length;
    const longManager = new ArchiveManager(plugin, manager, client, longSession, { ...policy, maxMangas: 1, maxChapters: 20 }, { source: longSource });
    const longState = await longManager.Start();
    record('Native IPC registers all 364 chapters but exports only twenty', longState.state === 'limited' && longState.counts.healthy === 20 && longState.counts.pending === 344);
    record('Long native manga retains oldest-first order across SQLite batches', visited.slice(beforeLong).join(',') === Array.from({ length: 20 }, (_, index) => `long-manager/c${index}`).join(','));
    const storageSession = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: 'site', siteName: 'Site', settings });
    const storageSource = { site: plugin,
        Catalog: async function* () { yield { items: [{ id: 'storage-manager', title: 'Storage Manager' }], terminal: true, coverage: { state: 'unknown', evidence: 'Isolated capacity fixture' } }; },
        Chapters: async () => ({ chapters: [{ id: 'only', title: 'Only', position: 0, language: null }], order: 'ascending', orderEvidence: 'Fixture', coverage: { state: 'unknown', evidence: '' } }),
    };
    const storageManager = new ArchiveManager(plugin, manager, client, storageSession, { ...policy, maxMangas: 1, maxChapters: 2 }, { source: storageSource });
    const beforeStorage = visited.length;
    await ipcRenderer.invoke('ArchiveStorageTest::Capacity', 'low');
    const storageStopped = await storageManager.Start();
    record('Native storage shortage pauses the session with a structured reason before fetching', storageStopped.state === 'paused' && storageStopped.storageError.code === 'low-space' && visited.length === beforeStorage);
    const manualMedia = { Identifier: 'manual-storage-control', Entries: { Value: [{ Fetch: async () => image }] },
        Update: async () => {}, IsSameAs: () => false, Store: async (_resources, options) => {
            await options.context.begin(1);
            options.context.writing('manual-fixture.bin');
            options.context.written({ path: 'manual-fixture.bin', size: image.size, handle: { getFile: async () => image } });
        } };
    const manualHandle = await manager.EnqueueTask(manualMedia, { owner: 'manual', retention: 'release' });
    record('Manual engine download remains independent of the archive reserve', (await manualHandle.completion).outcome === 'succeeded');
    await ipcRenderer.invoke('ArchiveStorageTest::Capacity', 'enough');
    const storageResumed = await storageManager.Resume();
    record('Native session resumes after capacity is restored without resetting the development budget', storageResumed.counts.healthy === 1 && storageResumed.storageError === null && storageResumed.chaptersStarted === 1);
    const stagedSession = await client.Request({ operation: 'create-session', rootId: grant.rootId, siteId: 'site', siteName: 'Site', settings });
    const stagedSource = { ...storageSource, Catalog: async function* () {
        yield { items: [{ id: 'staged-storage', title: 'Staged Storage' }], terminal: true, coverage: { state: 'unknown', evidence: 'Isolated staged publication fixture' } };
    } };
    const stagedManager = new ArchiveManager(plugin, manager, client, stagedSession, { ...policy, maxMangas: 1, maxChapters: 2 }, { source: stagedSource });
    const beforeStaged = visited.length;
    await ipcRenderer.invoke('ArchiveStorageTest::BlockPublication');
    const blockedPublication = await stagedManager.Start();
    const injected = await ipcRenderer.invoke('ArchiveStorageTest::PublicationProbe');
    record('Staged publication capacity fault targets the native directory identity rather than its path spelling', injected.injected && injected.sameIdentity);
    record('Low space before native publication preserves the staged chapter and pauses', blockedPublication.state === 'paused' && blockedPublication.storageError.code === 'low-space' && visited.length === beforeStaged + 1);
    await ipcRenderer.invoke('ArchiveStorageTest::Capacity', 'enough');
    const publishedAfterResume = await stagedManager.Resume();
    record('Restored capacity publishes a verified staging receipt without downloading its images again', publishedAfterResume.counts.healthy === 1 && publishedAfterResume.chaptersStarted === 1 && visited.length === beforeStaged + 1);
    for (let retry = 0; manager.Queue.Value.length && retry < 50; retry++) await new Promise(resolve => setTimeout(resolve, 10));
    record('Completed archive tasks do not remain in manager history', manager.Queue.Value.length === 0);
    return checks;
})()
