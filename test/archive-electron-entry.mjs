import { app, BrowserWindow, dialog, ipcMain } from 'electron';
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
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    const url = process.env.HARUNEKO_ARCHIVE_TEST_URL;
    const preferences = { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: process.env.HARUNEKO_ARCHIVE_TEST_PRELOAD };
    window = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: preferences });
    let available = 1024n ** 4n;
    let blockPublication = false;
    // All overrides live in this isolated test entry, never in the production main process.
    ipcMain.handle('ArchiveStorageTest::Capacity', (_event, state) => { available = state === 'low' ? 0n : 1024n ** 4n; });
    ipcMain.handle('ArchiveStorageTest::BlockPublication', () => { blockPublication = true; });
    service = new ArchiveIPC(window, new URL(url).origin, { storagePolicy: { reserveBytes: 1024n ** 2n, metadataHeadroomBytes: 1024n ** 2n },
        storageProbe: async directory => {
            const observed = await ProbeArchiveVolume(directory);
            if (blockPublication && directory === path.join(profile, 'archive', 'staging')) {
                const entries = await fs.readdir(directory);
                for (const name of entries) if ((await fs.stat(path.join(directory, name))).size > 0) {
                    blockPublication = false; available = 0n; break;
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
    const indexChecks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_SITE_INDEX_TEST_SCRIPT, 'utf8'));
    for (const check of indexChecks) assert.equal(check.passed, true, check.name);
    const priorityChecks = process.env.HARUNEKO_PRIORITY_TEST_SCRIPT ? await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_PRIORITY_TEST_SCRIPT, 'utf8')) : [];
    for (const check of priorityChecks) assert.equal(check.passed, true, check.name);
    if (process.env.HARUNEKO_ARCHIVE_TEST_SCREENSHOT) await fs.writeFile(process.env.HARUNEKO_ARCHIVE_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    const fixture = await window.webContents.executeJavaScript('globalThis.archiveUIFixture');
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
    console.log(`${checks.length + uiChecks.length + hubChecks.length + indexChecks.length + indexMigrationChecks.length + priorityChecks.length + 13} Electron renderer/IPC/archive UI pipeline checks passed`);
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
