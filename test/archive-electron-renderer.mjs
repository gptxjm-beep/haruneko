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
    for (let retry = 0; manager.Queue.Value.length && retry < 50; retry++) await new Promise(resolve => setTimeout(resolve, 10));
    record('Completed archive tasks do not remain in manager history', manager.Queue.Value.length === 0);
    return checks;
})()
