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
    window = new BrowserWindow({ show: false, webPreferences: preferences });
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
    window.webContents.on('console-message', event => console.log('renderer:', event.message));
    console.log('Loading isolated renderer');
    await window.loadURL(url);
    assert.equal(path.resolve(window.webContents.session.getStoragePath()), path.resolve(profile), 'Browser storage must use the isolated test profile');
    console.log('Running renderer archive checks');
    const checks = await window.webContents.executeJavaScript(await fs.readFile(process.env.HARUNEKO_ARCHIVE_TEST_SCRIPT, 'utf8'));
    for (const check of checks) assert.equal(check.passed, true, check.name);
    other = new BrowserWindow({ show: false, webPreferences: preferences });
    await other.loadURL(url);
    const denied = await other.webContents.executeJavaScript(`ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'list-sessions' }).then(() => false, error => error.message.includes('not authorized'))`);
    assert.equal(denied, true, 'A second renderer must not use the archive repository');
    const written = await fs.readFile(path.join(root, 'Site', 'Manga', 'Chapter 1', '1.png'));
    assert.equal(written[0], 0x89);
    console.log(`${checks.length + 3} Electron renderer/IPC/archive pipeline checks passed`);
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
