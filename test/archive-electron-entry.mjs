import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ArchiveIPC } from '../app/electron/src/archive/ArchiveIPC.ts';
import { ProbeArchiveVolume } from '../app/electron/src/archive/ArchiveStorageSafety.ts';

async function Main() {
const directory = process.env.HARUNEKO_ARCHIVE_TEST_DIRECTORY;
if (!directory || !path.basename(directory).startsWith('haruneko-archive-electron-')) throw new Error('An isolated test directory is required');
const profile = path.join(directory, 'profile');
const root = path.join(directory, 'output');
await fs.mkdir(profile, { recursive: true });
await fs.mkdir(root, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
await app.whenReady();
let window;
let service;
let other;
try {
    // Test-only native dialog fixture. Production code contains no test path override.
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes('openFile') ? path.join(root, 'Queue source A', 'Berserk Queue', '00 - Manga Details', 'cover.png') : root] });
    const nativeOpenPath = shell.openPath.bind(shell);
    let openedMangaFolder = false;
    shell.openPath = async target => {
        const expected = path.join(root, 'Queue source A', 'Berserk Queue');
        const [actualIdentity, expectedIdentity] = await Promise.all([fs.stat(target, { bigint: true }), fs.stat(expected, { bigint: true })]);
        openedMangaFolder = actualIdentity.isDirectory() && expectedIdentity.isDirectory()
            && actualIdentity.dev === expectedIdentity.dev && actualIdentity.ino === expectedIdentity.ino
            && await fs.realpath(target) === await fs.realpath(expected);
        if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Open Folder fixture::Expected native directory: ${openedMangaFolder}; identical path spelling: ${target === expected}`);
        if (process.platform === 'win32' && openedMangaFolder) {
            assert.equal(await nativeOpenPath(target), '', 'The real Windows file browser must accept the isolated manga folder');
            console.log('Real Windows shell.openPath accepted the isolated manga directory');
        }
        return '';
    };
    ipcMain.handle('QueueTest::FolderOpened', () => openedMangaFolder);
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(directory, 'isolated-download-report.json') });
    const url = process.env.HARUNEKO_ARCHIVE_TEST_URL;
    const preferences = { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: process.env.HARUNEKO_ARCHIVE_TEST_PRELOAD };
    window = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: preferences });
    let available = 1024n ** 4n;
    let blockPublication = false;
    let publicationProbe = { injected: false, sameSpelling: false, sameIdentity: false };
    // All overrides live in this isolated test entry, never in the production main process.
    ipcMain.handle('ArchiveStorageTest::Capacity', (_event, state) => { available = state === 'low' ? 0n : 1024n ** 4n; });
    ipcMain.handle('ArchiveStorageTest::BlockPublication', () => { blockPublication = true; publicationProbe = { injected: false, sameSpelling: false, sameIdentity: false }; });
    ipcMain.handle('ArchiveStorageTest::PublicationProbe', () => publicationProbe);
    service = new ArchiveIPC(window, new URL(url).origin, { storagePolicy: { reserveBytes: 1024n ** 2n, metadataHeadroomBytes: 1024n ** 2n },
        storageProbe: async directory => {
            const observed = await ProbeArchiveVolume(directory);
            if (blockPublication) {
                const expected = path.join(profile, 'archive', 'staging');
                const target = await fs.stat(expected, { bigint: true });
                if (observed.identity === `${target.dev}:${target.ino}`) {
                    const entries = await fs.readdir(directory);
                    for (const name of entries) if ((await fs.stat(path.join(directory, name))).size > 0) {
                        publicationProbe = { injected: true, sameSpelling: directory === expected, sameIdentity: true };
                        console.log(`Staging fault fixture identity matched; identical path spelling: ${publicationProbe.sameSpelling}`);
                        if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Staging fault fixture::Same native directory identity; identical path spelling: ${publicationProbe.sameSpelling}`);
                        blockPublication = false; available = 0n; break;
                    }
                }
            }
            return { ...observed, freeBytes: available, usableBytes: available };
        } });
    ipcMain.handle('ArchiveHubTest::Capture', async () => {
        if (process.env.HARUNEKO_HUB_TEST_SCREENSHOT) {
            window.showInactive();
            await new Promise(resolve => setTimeout(resolve, 300));
            await fs.writeFile(process.env.HARUNEKO_HUB_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        }
    });
    ipcMain.handle('SearchTest::Memory', () => app.getAppMetrics().find(item => item.pid === window.webContents.getOSProcessId())?.memory ?? null);
    ipcMain.handle('SearchTest::Capture', async () => {
        if (process.env.HARUNEKO_SEARCH_TEST_SCREENSHOT) { window.showInactive(); await new Promise(resolve => setTimeout(resolve, 300)); await fs.writeFile(process.env.HARUNEKO_SEARCH_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG()); }
    });
    ipcMain.handle('QueueTest::ManualInfoEdit', async () => {
        const file = path.join(root, 'Queue source A', 'Berserk Queue', '00 - Manga Details', 'metadata.json');
        const metadata = JSON.parse(await fs.readFile(file, 'utf8'));
        metadata.title = 'Externally edited title'; metadata.fields.Description = 'Manual JSON story <img src=x onerror=alert(1)>';
        await fs.writeFile(file, JSON.stringify(metadata));
    });
    ipcMain.handle('QueueTest::OfflineDetails', async () => {
        const local = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'offline-details-test' } });
        let requests = 0;
        local.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { requests++; callback({ cancel: true }); });
        try {
            await local.loadFile(path.join(root, 'Queue source A', 'Berserk Queue', '00 - Manga Details.html'));
            const result = await local.webContents.executeJavaScript('({ title: document.title, text: document.body.innerText, width: document.querySelector("img")?.naturalWidth, images: document.images.length, scripts: document.scripts.length })');
            return { ...result, requests };
        } finally { local.webContents.session.webRequest.onBeforeRequest(null); local.destroy(); }
    });
    ipcMain.handle('QueueTest::RemoveIsolatedChapter', async () => {
        // Fixed fixture output only; renderer supplies no path and this directory is created by this harness.
        const manga = path.join(root, 'Queue source A', 'Berserk Queue');
        const walk = async directory => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                if (entry.name === '00 - Manga Details') continue;
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) { if (await walk(file)) return true; }
                else if (entry.isFile() && /\.(cbz|png|jpg)$/.test(entry.name)) { await fs.unlink(file); return true; }
            }
            return false;
        };
        if (!await walk(manga)) throw new Error('Isolated chapter fixture not found');
    });
    ipcMain.handle('QueueTest::Capture', async () => {
        if (process.env.HARUNEKO_QUEUE_TEST_SCREENSHOT) { window.showInactive(); await new Promise(resolve => setTimeout(resolve, 300)); await fs.writeFile(process.env.HARUNEKO_QUEUE_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG()); }
    });
    window.webContents.on('console-message', event => console.log('renderer:', event.message));
    console.log('Loading isolated renderer');
    await window.loadURL(url);
    assert.equal(path.resolve(window.webContents.session.getStoragePath()), path.resolve(profile), 'Browser storage must use the isolated test profile');
    const indexMigrationChecks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_SITE_INDEX_MIGRATION_TEST_SCRIPT, 'utf8'));
    for (const check of indexMigrationChecks) assert.equal(check.passed, true, check.name);
    console.log('Running renderer archive checks');
    const checks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_ARCHIVE_TEST_SCRIPT, 'utf8'));
    for (const check of checks) assert.equal(check.passed, true, check.name);
    const uiChecks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_ARCHIVE_UI_TEST_SCRIPT, 'utf8'));
    for (const check of uiChecks) assert.equal(check.passed, true, check.name);
    const hubChecks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_ARABIC_HUB_TEST_SCRIPT, 'utf8'));
    for (const check of hubChecks) assert.equal(check.passed, true, check.name);
    const searchChecks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_SHARED_SEARCH_TEST_SCRIPT, 'utf8'));
    for (const check of searchChecks) assert.equal(check.passed, true, check.name);
    const queueChecks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_SELECTIVE_QUEUE_TEST_SCRIPT, 'utf8'));
    for (const check of queueChecks) assert.equal(check.passed, true, check.name);
    const explorerChecks = await window.webContents.executeJavaScript(await fs.readFile(path.resolve('test/library-explorer-renderer.mjs'), 'utf8'));
    for (const check of explorerChecks) assert.equal(check.passed, true, check.name);
    const priorityChecks = process.env.HARUNEKO_PRIORITY_TEST_SCRIPT ? await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_PRIORITY_TEST_SCRIPT, 'utf8')) : [];
    for (const check of priorityChecks) assert.equal(check.passed, true, check.name);
    // This script deliberately leaves an unfinished catalog job for the reload checks below.
    const indexChecks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_SITE_INDEX_TEST_SCRIPT, 'utf8'));
    for (const check of indexChecks) assert.equal(check.passed, true, check.name);
    if (process.env.HARUNEKO_ARCHIVE_TEST_SCREENSHOT) await fs.writeFile(process.env.HARUNEKO_ARCHIVE_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    const fixture = await window.webContents.executeJavaScript('globalThis.archiveUIFixture');
    const queueFixture = await window.webContents.executeJavaScript('globalThis.selectiveQueueFixture');
    const beforeReload = await window.webContents.executeJavaScript(`(async () => {
        const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts'); const client = new ArchiveClient();
        const progress = await client.Request({ operation: 'ui-progress', sessionId: '${fixture.id}' });
        await client.Request({ operation: 'archive-run-open', sessionId: '${fixture.id}', policy: progress.snapshot.policy });
        return progress.snapshot.chaptersStarted;
    })()`);
    await window.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    const afterReload = await window.webContents.executeJavaScript(`(async () => {
        const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts'); const client = new ArchiveClient();
        return { progress: await client.Request({ operation: 'ui-progress', sessionId: '${fixture.id}' }), preferences: await client.Request({ operation: 'ui-preferences' }) };
    })()`);
    const restoredOrder = await window.webContents.executeJavaScript(`(async () => {
        const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
        const { SettingsManager } = await import('/src/engine/SettingsManager.ts');
        const { CreateArabicFirstSetting } = await import('/src/frontend/classic/models/PluginPresentation.ts');
        const setting = CreateArabicFirstSetting();
        await new SettingsManager(new StorageControllerBrowser()).OpenScope('frontend.classic').Initialize(setting);
        return setting.Value;
    })()`);
    const queueRecovery = await window.webContents.executeJavaScript(`(async () => {
        const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts'); const client = new ArchiveClient();
        return { summary: await client.Request({ operation: 'queue-summary' }), selected: await client.Request({ operation: 'queue-selections' }), rows: await client.Request({ operation: 'queue-list' }) };
    })()`);
    const restoredCart = await window.webContents.executeJavaScript(`(async () => { const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts'); return new ArchiveClient().Request({ operation: 'cart-list' }); })()`);
    assert.equal(restoredCart.find(item => item.siteId === 'explorer-a' && item.mangaId === 'm-0').mode, 'except', 'Explorer partial cart selection survives renderer destruction');
    assert.deepEqual(restoredCart.find(item => item.siteId === 'explorer-a' && item.mangaId === 'm-0').ids, ['2']);
    assert.equal(queueRecovery.summary.state, 'Cancelled', 'Restoring the queue never automatically starts it');
    assert.equal(queueRecovery.summary.chaptersStarted, queueFixture.chaptersStarted, 'Queue attempt budgets survive renderer replacement');
    assert.equal(queueRecovery.selected.length, queueFixture.selected, 'Personal selections survive renderer replacement');
    assert.equal(queueRecovery.rows.length, queueFixture.queued, 'Personal queue order and references survive renderer replacement');
    assert.deepEqual(queueRecovery.rows.find(row => row.seq === queueFixture.chapterSelection).scope.ids, ['1','2','3'], 'The real fifteen-chapter Svelte selection survives renderer destruction');
    const indexRecovery = await window.webContents.executeJavaScript(`(async () => {
        const { SiteIndexRepository } = await import('/src/engine/catalog/SiteIndexRepository.ts');
        const { SiteIndexManager } = await import('/src/engine/catalog/SiteIndexManager.ts');
        const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
        const { Store } = await import('/src/engine/StorageController.ts');
        let callsA = 0, callsB = 0;
        const repository = new SiteIndexRepository();
        const manager = new SiteIndexManager(repository, () => [{ id: 'index-recovery-a', Catalog: async function* () { callsA++; } },
            { id: 'index-recovery-b', Catalog: async function* () { callsB++; yield { items: [{ id: 'b', title: 'Manga b' }], terminal: true, coverage: { state: 'unknown', evidence: 'Post-reload fixture observations' } }; } }], navigator.locks, { timeoutMs: 10000, delayMs: 1, retryMs: 1 });
        await manager.Initialize(); const before = manager.State.Value.job;
        if (callsA || callsB || before.state !== 'interrupted') throw new Error('Index unexpectedly auto-started after reload');
        await manager.Resume(); const deadline = Date.now() + 10000;
        while (manager.Activity.Value.owned && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        const storage = new StorageControllerBrowser();
        return { callsA, callsB, state: manager.State.Value.job.state, attempts: manager.State.Value.job.items[1].attempts,
            savedA: await storage.LoadPersistent(Store.MediaLists, 'index-recovery-a'), savedB: await storage.LoadPersistent(Store.MediaLists, 'index-recovery-b') };
    })()`);
    assert.equal(indexRecovery.callsA, 0, 'Catalog recovery must reuse prior successful sites');
    assert.equal(indexRecovery.callsB, 1, 'Catalog recovery must restart only the interrupted site');
    assert.equal(indexRecovery.state, 'finished');
    assert.equal(indexRecovery.attempts, 2, 'An interrupted catalog attempt must remain in the bounded attempt budget');
    assert.equal(indexRecovery.savedA[0].id, 'a');
    assert.equal(indexRecovery.savedB[0].id, 'b');
    const searchRecovery = await window.webContents.executeJavaScript(`(async () => {
        const { LocalSearchController } = await import('/src/engine/search/LocalSearchController.ts');
        const { SearchWorkerClient } = await import('/src/engine/search/SearchWorkerClient.ts');
        const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
        const client = new SearchWorkerClient();
        const controller = new LocalSearchController(new StorageControllerBrowser(), client, () => [{ id: 'search-a', title: 'A' }, { id: 'search-b', title: 'B' }]);
        await controller.Initialize(); const preference = controller.State.Value.preference;
        const result = await client.Search(preference, controller.Sites()); controller.Close();
        return { preference, total: result.total, ids: result.groups.flatMap(group => group.rows).map(row => [row.siteId, row.mangaId]) };
    })()`);
    assert.equal(searchRecovery.preference.query, 'one piece', 'Search query survives renderer destruction');
    assert.equal(searchRecovery.total, 3, 'Local accepted results survive renderer destruction without contacting connectors');
    assert.equal(searchRecovery.ids.length, 3);
    assert.equal(restoredOrder, false, 'Classic ordering preference survives a real renderer reload in isolated IndexedDB');
    assert.equal(afterReload.progress.snapshot.state, 'interrupted', 'Renderer replacement must interrupt orphan runs without auto-resume');
    assert.equal(afterReload.progress.snapshot.chaptersStarted, beforeReload, 'Renderer replacement must preserve the cumulative budget');
    assert.equal(afterReload.preferences.preferences.policy.delayMs, 2000);
    other = new BrowserWindow({ show: false, webPreferences: preferences });
    await other.loadURL(url);
    const denied = await other.webContents.executeJavaScript(`ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'list-sessions' }).then(() => false, error => error.message.includes('not authorized'))`);
    assert.equal(denied, true, 'A second renderer must not use the archive repository');
    const written = await fs.readFile(path.join(root, 'Site', 'Manga', 'Chapter 1', '1.png'));
    assert.equal(written[0], 0x89);
    console.log(`${checks.length + explorerChecks.length + uiChecks.length + hubChecks.length + indexChecks.length + indexMigrationChecks.length + searchChecks.length + queueChecks.length + priorityChecks.length + 20} Electron renderer/IPC/archive UI pipeline checks passed`);
    await service.Close();
    other.destroy(); window.destroy();
    app.exit(0);
} catch(error) {
    console.error(error);
    await service?.Close();
    other?.destroy(); window?.destroy();
    app.exit(1);
}

}
Main().catch(error => { console.error(error); app.exit(1); });
