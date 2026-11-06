// Own temporary Preview profile only. Seed the real pre-catalog IndexedDB origin before the packaged app starts.
import { app, BrowserWindow, session } from 'electron';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
async function Main() {
const directory = process.argv.at(-1);
for (const [key, leaf] of Object.entries({ userData: 'profile', sessionData: 'browser', temp: 'temp', logs: 'logs', crashDumps: 'crashes' })) {
    const target = path.join(directory, leaf); await fs.mkdir(target, { recursive: true }); app.setPath(key, target);
}
const server = createServer((_request, response) => response.end('<title>Isolated legacy profile seed</title>'));
try {
    console.log('Legacy seed: isolated paths configured');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(47831, '127.0.0.1', resolve); });
    await app.whenReady();
    console.log('Legacy seed: Electron ready');
    const window = new BrowserWindow({ show: false });
    await window.loadURL('http://127.0.0.1:47831');
    console.log('Legacy seed: local document loaded');
    await window.webContents.executeJavaScript(`(async () => {
        const request = indexedDB.open('HakuNeko', 5);
        request.onupgradeneeded = () => { for (const name of ['Settings','Bookmarks','MediaLists','TemporaryData','Itemflags']) request.result.createObjectStore(name); };
        const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise((resolve, reject) => { const tx = db.transaction('MediaLists','readwrite'); tx.objectStore('MediaLists').put([{ id:'legacy',title:'Preserved legacy catalog' }],'preview-legacy'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        db.close();
    })()`);
    session.defaultSession.flushStorageData(); window.destroy();
    console.log('Legacy seed: IndexedDB fixture committed');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.exit(0);
} catch { console.error('PREVIEW_LEGACY_SEED_FAILED'); server.closeAllConnections(); server.close(); app.exit(1); }

}
Main().catch(() => { console.error('PREVIEW_LEGACY_SEED_FAILED'); app.exit(1); });
