// Runs the actual bundled main process. Uses only isolated test profiles; no live connector requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import puppeteer from 'puppeteer-core';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-preview-smoke-'));
const unpacked = path.join(root, 'portable'); await fs.mkdir(unpacked);
const zipIndex = process.argv.indexOf('--zip');
let appPath; let executable;
if (zipIndex !== -1) {
    if (process.platform !== 'win32') throw new Error('Windows ZIP execution requires Windows');
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
const report = { platform: process.platform, checks: [], commit: '', electron: '', sqlite: '' };
const check = (name, passed) => { assert.equal(passed, true, name); report.checks.push(name); console.log('PASS', name); };
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
try {
    const page = await Launch();
    check('CLI hosted origin is ignored; the bundled loopback UI loads', new URL(page.url()).origin === origin);
    const info = await page.evaluate(() => ipcRenderer.invoke('Preview::Info'));
    check('Preview identity and SQLite are provided by actual Electron', info.name === 'HaruNeko Enhanced Preview' && info.localUI && /^3\./.test(info.sqlite));
    report.commit = info.commit; report.electron = info.electron; report.sqlite = info.sqlite;
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
    console.log('Closing the actual Preview window');
    await Stop(page);
    console.log('Preview closed; relaunching');
    const again = await Launch();
    const restored = await again.evaluate(() => ipcRenderer.invoke('ArchiveRepository::Request', { operation: 'ui-preferences' }));
    check('SQLite preferences survive a real application relaunch', restored.ok && restored.value.preferences.policy.delayMs === 1500);
    await Stop(again);
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
