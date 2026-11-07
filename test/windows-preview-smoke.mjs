// Runs the actual bundled main process. Uses only isolated test profiles; no live connector requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { MigrateArchiveDatabase } from '../app/electron/src/archive/ArchiveSchema.ts';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-preview-smoke-'));
const unpacked = path.join(root, 'portable'); await fs.mkdir(unpacked);
const zipIndex = process.argv.indexOf('--zip');
let appPath; let executable; let packageSha256 = null;
if (zipIndex !== -1) {
    if (process.platform !== 'win32') throw new Error('Windows ZIP execution requires Windows');
    packageSha256 = createHash('sha256').update(await fs.readFile(process.argv[zipIndex + 1])).digest('hex');
    assert.equal(packageSha256, (await fs.readFile(process.argv[zipIndex + 1] + '.sha256', 'utf8')).trim().split(/\s+/)[0], 'ZIP checksum matches the tested bundle');
    new AdmZip(process.argv[zipIndex + 1]).extractAllTo(unpacked, false);
    appPath = path.join(unpacked, 'resources/app'); executable = path.join(unpacked, 'HaruNekoEnhancedPreview.exe');
} else {
    const latest = JSON.parse(await fs.readFile('app/electron/bundle/preview-last.json', 'utf8'));
    appPath = path.join(unpacked, 'resources/app'); await fs.mkdir(path.dirname(appPath), { recursive: true });
    await fs.cp(latest.appPath, appPath, { recursive: true });
    executable = path.resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
}
const original = path.join(root, 'original-appdata', 'HakuNeko'); await fs.mkdir(original, { recursive: true });
await fs.writeFile(path.join(original, 'original-settings.json'), '{"original":"untouched"}');
const origin = 'http://127.0.0.1:47831';
let browser;
const report = { platform: process.platform, checks: [], commit: '', electron: '', sqlite: '', packageSha256 };
const check = (name, passed) => { assert.equal(passed, true, name); report.checks.push(name); console.log('PASS', name); };
const portableData = path.join(unpacked, 'haruneko-preview-data');
try {
await fs.mkdir(path.join(portableData, 'profile/archive'), { recursive: true });
const archiveRoot = path.join(root, 'archive-output'); await fs.mkdir(archiveRoot);
const seedDatabase = new DatabaseSync(path.join(portableData, 'profile/archive/state.sqlite'));
MigrateArchiveDatabase(seedDatabase, 9);
const identity = await fs.stat(archiveRoot, { bigint: true });
seedDatabase.prepare('INSERT INTO roots(id,path,label,identity) VALUES(?,?,?,?)').run('smoke-root', await fs.realpath(archiveRoot), 'Isolated smoke archive', `${identity.dev}:${identity.ino}`);
seedDatabase.prepare('INSERT INTO hub_selections(site_id,manga_id,title,site_name) VALUES(?,?,?,?)').run('legacy-site', 'legacy-manga', 'Preserved v9 selection', 'Legacy fixture');
seedDatabase.close();
const seedEnv = { ...process.env }; delete seedEnv.ELECTRON_RUN_AS_NODE;
const seedElectron = path.resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
await new Promise((resolve, reject) => {
    const child = spawn(seedElectron, ['--no-sandbox', path.resolve('test/preview-legacy-profile.mjs'), portableData], { env: seedEnv, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Legacy browser profile seeding timed out')); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Legacy browser profile seeding failed')); });
});
async function Launch() {
    browser = await puppeteer.launch({ executablePath: executable, headless: false, ignoreDefaultArgs: true, timeout: 45000, dumpio: false,
        args: [...(zipIndex === -1 ? [appPath] : []), '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--origin=https://app.hakuneko.download', `--user-data-dir=${path.join(unpacked, 'haruneko-preview-data', 'profile')}`],
        env: { ...process.env, APPDATA: path.dirname(original), XDG_CONFIG_HOME: path.dirname(original) } });
    let page;
    const deadline = Date.now() + 45000;
    while (!page) {
        page = (await browser.pages()).find(candidate => candidate.url().startsWith(origin));
        if (Date.now() > deadline) throw new Error('Preview did not load its local origin');
        if (!page) await new Promise(resolve => setTimeout(resolve, 100));
    }
    await page.waitForSelector('#app main#hakunekoapp', { timeout: 45000 });
    await page.evaluate(() => { HakuNeko.SettingsManager.OpenScope('frontend.classic').Get('startup-guide-enabled').Value = false; });
    return page;
}
async function Stop(page) {
    const child = browser.process();
    const exited = new Promise((resolve, reject) => {
        if (child.exitCode !== null) { resolve(); return; }
        const timer = setTimeout(() => reject(new Error('Preview failed to close its actual application window')), 15000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await page.evaluate(() => { void ipcRenderer.invoke('ApplicationWindow::Close'); }).catch(() => {});
    await exited;
    browser.disconnect();
    browser = undefined;
}
    const page = await Launch();
    check('CLI hosted origin is ignored; the bundled loopback UI loads', new URL(page.url()).origin === origin);
    const info = await page.evaluate(() => ipcRenderer.invoke('Preview::Info'));
    check('Preview identity and SQLite are provided by actual Electron', info.name === 'HaruNeko Enhanced Preview' && info.localUI && /^3\./.test(info.sqlite));
    report.commit = info.commit; report.electron = info.electron; report.sqlite = info.sqlite;
    check('Artifact source matches the exact checked-out commit', info.commit === execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    if (!process.argv.includes('--allow-dirty')) check('Artifact source is a clean committed build', info.dirty === false);
    check('Classic contains Archive Site and optional diagnostics', await page.evaluate(() => ['Archive Site', 'Image Diagnostics (Preview)'].every(text => [...document.querySelectorAll('nav a')].some(node => node.textContent.trim() === text))));
    await page.evaluate(() => [...document.querySelectorAll('nav a')].find(node => node.textContent.trim() === 'Image Diagnostics (Preview)').click());
    await page.waitForFunction(() => document.body.textContent.includes('Select a manga chapter first'));
    check('Optional diagnostics refuse to run without a selected chapter', true);
    await page.evaluate(() => document.querySelector('.bx--modal.is-visible .bx--modal-close').click());
    await page.evaluate(() => [...document.querySelectorAll('nav a')].find(node => node.textContent.trim() === 'Archiving').click());
    await page.waitForSelector('#settingModal.is-visible');
    check('Archiving is the fifth settings tab', await page.evaluate(() => [...document.querySelectorAll('#settingModal [role="tab"]')].map(node => node.textContent.trim()).join(',') === 'General,Interface,Viewer,Trackers,Archiving'));
    const prefs = await page.evaluate(() => ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'ui-preferences' }));
    check('Archive reserve and hard development limits remain safe', prefs.ok && prefs.value.preferences.reserveGiB === 50 && prefs.value.preferences.policy.maxMangas === 5 && prefs.value.preferences.policy.maxChapters === 20);
    const sessions = await page.evaluate(() => ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'ui-sessions' }));
    check('Startup does not create or start archive sessions', sessions.ok && sessions.value.length === 0);
    await page.evaluate(async preferences => { preferences.policy.delayMs = 1500; const saved = await ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'ui-save-preferences', preferences }); if (!saved.ok) throw new Error('Isolated SQLite save failed'); }, prefs.value.preferences);
    await page.evaluate(() => document.querySelector('#settingModal .bx--modal-close').click());
    await page.evaluate(() => {
        const site = HakuNeko.PluginController.WebsitePlugins.find(plugin => plugin.Identifier === 'mangatek');
        if (!site) throw new Error('Bundled Arabic connector missing');
        const scraper = site.CreateEntry('fixture', 'Fixture').scraper;
        scraper.Initialize = async () => {};
        scraper.FetchMangas = async () => [site.CreateEntry('preview-one', 'Preview Smoke One'), site.CreateEntry('preview-two', 'Preview Smoke Two')];
        scraper.FetchChapters = async () => { throw new Error('Preview metadata test must not fetch chapter content'); };
        Object.defineProperty(HakuNeko.PluginController, 'WebsitePlugins', { value: [site], configurable: true });
        if (HakuNeko.PluginController.WebsitePlugins.length !== 1) throw new Error('Fixture connector isolation failed');
        const originalFetch = window.fetch;
        window.fetch = (request, ...args) => { const url = new URL(typeof request === 'string' ? request : request.url, location.href); if (url.origin !== location.origin) throw new Error('Live network disabled in Preview smoke'); return originalFetch(request, ...args); };
        [...document.querySelectorAll('nav a')].find(node => node.textContent.trim() === 'Arabic Manga').click();
    });
    await page.waitForSelector('#ArabicManga');
    await page.evaluate(() => [...document.querySelectorAll('#ArabicManga nav button')].find(button => button.textContent.trim() === 'Sites').click());
    check('Bundled Classic opens the actual Arabic Manga hub', true);
    await page.waitForFunction(() => [...document.querySelectorAll('#ArabicManga button')].some(button => button.textContent.trim() === 'Update All Arabic Sites' && !button.disabled));
    await page.evaluate(() => [...document.querySelectorAll('#ArabicManga button')].find(button => button.textContent.trim() === 'Update All Arabic Sites').click());
    await page.waitForFunction(async () => { const request = indexedDB.open('HakuNeko'); const db = await new Promise(resolve => request.onsuccess = () => resolve(request.result)); const meta = await new Promise(resolve => { const r = db.transaction('SiteIndexMetadata').objectStore('SiteIndexMetadata').get('mangatek'); r.onsuccess = () => resolve(r.result); }); db.close(); return meta?.state === 'succeeded'; });
    check('Bundled Update All publishes the isolated Arabic catalog without chapter or image requests', true);
    await page.evaluate(() => [...document.querySelectorAll('#ArabicManga nav button')].find(button => button.textContent.trim() === 'Search').click());
    await page.waitForSelector('[data-testid="shared-search-query"]:not(:disabled)');
    await page.type('[data-testid="shared-search-query"]', 'Preview Smoke');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="shared-search-result"]').length === 2);
    await page.click('[data-testid="shared-search-result"] input[type=checkbox]');
    await page.waitForFunction(async () => (await ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'queue-summary' })).value.selected === 2);
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="shared-search-result"] button')].filter(button => button.textContent.trim() === 'Add to Queue').forEach(button => button.click()));
    await page.waitForFunction(async () => (await ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'queue-summary' })).value.queued === 2);
    check('Packaged local Worker search, independent selection and individual queue additions work', true);
    await page.evaluate(() => [...document.querySelectorAll('#ArabicManga nav button')].find(button => button.textContent.trim() === 'Downloads').click());
    await page.waitForSelector('[data-testid="personal-queue"]');
    check('Packaged Downloads explains equivalent scopes, confirmed membership and SQLite compatibility', await page.evaluate(() => document.querySelector('[data-testid="queue-scope-notice"]').textContent.includes('All and Missing') && document.querySelector('[data-testid="queue-run-membership"]') !== null && document.querySelector('[data-testid="personal-queue"]').textContent.includes('SQLite v10')));
    const queueBefore = await page.evaluate(async () => {
        const request = async command => { const reply = await ipcRenderer.invoke('ArchiveRepository::Request', command); if (!reply.ok) throw new Error(reply.error.message); return reply.value; };
        const defaults = await request({ operation: 'ui-preferences' }); const preferences = { ...defaults.preferences, rootId: 'smoke-root' };
        const opened = await request({ operation: 'queue-open', preferences, confirmed: true }); const first = await request({ operation: 'queue-next' });
        await request({ operation: 'queue-add', reference: { siteId: 'mangatek', mangaId: 'preview-later', title: 'Later Preview entry', siteName: 'MangaTek' } });
        await request({ operation: 'queue-stop', state: 'Paused', reason: 'Isolated Preview resume check; no content was requested' });
        return { batchId: opened.batchId, sessionId: first.sessionId, seq: first.seq };
    });
    console.log('Closing the actual Preview window');
    await Stop(page);
    console.log('Preview closed; relaunching');
    const again = await Launch();
    const restored = await again.evaluate(() => ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'ui-preferences' }));
    check('SQLite preferences survive a real application relaunch', restored.ok && restored.value.preferences.policy.delayMs === 1500);
    await again.evaluate(() => [...document.querySelectorAll('nav a')].find(node => node.textContent.trim() === 'Arabic Manga').click());
    await again.waitForSelector('#ArabicManga');
    await again.evaluate(() => [...document.querySelectorAll('#ArabicManga nav button')].find(button => button.textContent.trim() === 'Downloads').click());
    await again.waitForFunction(() => document.querySelectorAll('[data-testid="personal-entry"]').length === 3);
    check('Actual Classic queue reopens with persisted entries and does not auto-start them', true);
    const resumed = await again.evaluate(async before => {
        const request = async command => { const reply = await ipcRenderer.invoke('ArchiveRepository::Request', command); if (!reply.ok) throw new Error(reply.error.message); return reply.value; };
        const summary = await request({ operation: 'queue-summary' });
        const selected = await request({ operation: 'queue-selections' });
        await request({ operation: 'queue-open', preferences: summary.preferences, confirmed: true });
        const first = await request({ operation: 'queue-next' }); await request({ operation: 'queue-result', seq: first.seq, reason: 'Metadata-only Preview fixture' });
        const second = await request({ operation: 'queue-next' }); await request({ operation: 'queue-result', seq: second.seq, reason: 'Metadata-only Preview fixture' });
        const next = await request({ operation: 'queue-next' }); const after = await request({ operation: 'queue-summary' });
        const rows = await request({ operation: 'queue-list' });
        const open = indexedDB.open('HakuNeko'); const db = await new Promise(resolve => open.onsuccess = () => resolve(open.result));
        const legacy = await new Promise(resolve => { const r = db.transaction('MediaLists').objectStore('MediaLists').get('preview-legacy'); r.onsuccess = () => resolve(r.result); }); const version = db.version; db.close();
        return { preserved: summary.state === 'Paused' && summary.batchId === before.batchId && first.sessionId === before.sessionId,
            deferred: next === null && after.state === 'Drained' && rows.find(row => row.mangaId === 'preview-later').sessionId === null,
            selected: selected.length, legacy: legacy?.[0]?.id === 'legacy', version };
    }, queueBefore);
    check('Queue resume preserves the confirmed run and task identity while late additions remain unstarted', resumed.preserved && resumed.deferred);
    check('SQLite v9 selections survive migration and real EXE relaunch', resumed.selected === 2);
    check('IndexedDB v5 upgrades to v6 without losing the legacy catalog', resumed.version === 6 && resumed.legacy);
    await Stop(again);
    const upgraded = new DatabaseSync(path.join(portableData, 'profile/archive/state.sqlite'));
    report.archiveSchema = Number(upgraded.prepare('PRAGMA user_version').get().user_version); upgraded.close();
    check('Packaged main migrates SQLite v9 to v10', report.archiveSchema === 10);
    const data = path.join(unpacked, 'haruneko-preview-data');
    check('Archive database resides inside the portable preview profile', (await fs.stat(path.join(data, 'profile/archive/state.sqlite'))).isFile());
    check('Chromium browser storage is isolated inside the preview directory', (await fs.stat(path.join(data, 'browser'))).isDirectory());
    check('Original profile sentinel and directory are untouched', await fs.readFile(path.join(original, 'original-settings.json'), 'utf8') === '{"original":"untouched"}' && (await fs.readdir(original)).length === 1);
    const manifest = JSON.parse(await fs.readFile(path.join(appPath, 'preview-manifest.json'), 'utf8'));
    const scripts = await Promise.all(Object.keys(manifest.assets).filter(name => name.endsWith('.js')).map(name => fs.readFile(path.join(appPath, 'web', name), 'utf8')));
    const source = scripts.join('\n');
    check('Packaged web assets contain connector fixes and image validation', ['data-lazy-src', 'data-srcset', 'Reader image source is missing or unsupported', 'Downloaded page could not be decoded as an image'].every(text => source.includes(text)));
    const output = path.resolve(`app/electron/bundle/preview-smoke-${process.platform}.json`); await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(`${report.checks.length} actual Preview application checks passed on ${process.platform}`);
} catch(error) { console.error('PREVIEW_SMOKE_FAILED', error); throw error; } finally { if (browser) { browser.process()?.kill('SIGKILL'); browser.disconnect(); } await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
