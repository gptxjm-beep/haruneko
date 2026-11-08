import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { PreparePreview } from './prepare-preview.mjs';
const build = await PreparePreview(process.argv.includes('--allow-dirty'));
async function CheckNative(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await CheckNative(file);
        else if (entry.name.endsWith('.node') && process.platform !== 'win32') throw new Error('Native addons require a Windows build');
    }
}
await CheckNative(build.appPath);
const archive = `electron-v${build.electron}-win32-x64.zip`;
const origin = `https://github.com/electron/electron/releases/download/v${build.electron}/`;
async function Get(name) {
    const response = await fetch(origin + name);
    if (!response.ok) throw new Error(`Electron download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
}
const sums = (await Get('SHASUMS256.txt')).toString('utf8');
const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1]?.replace(/^\*/, '') === archive)?.[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Official Electron checksum unavailable');
const bytes = await Get(archive);
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Electron checksum mismatch');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-windows-preview-'));
try {
    new AdmZip(bytes).extractAllTo(temporary, false);
    await fs.cp(build.appPath, path.join(temporary, 'resources/app'), { recursive: true });
    await fs.writeFile(path.join(temporary, 'BUILD-INFO.json'), JSON.stringify({ sourceCommit: build.commit, dirty: build.dirty, electron: build.electron, architecture: 'x64', packagedOn: process.platform, windowsExecution: 'Requires a separate Windows smoke report' }, null, 2));
    await fs.rename(path.join(temporary, 'electron.exe'), path.join(temporary, 'HaruNekoEnhancedPreview.exe'));
    await fs.writeFile(path.join(temporary, 'Start-HaruNeko-Enhanced-Preview.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nstart "" /wait "%~dp0HaruNekoEnhancedPreview.exe" --user-data-dir="%~dp0haruneko-preview-data\\profile" --disk-cache-dir="%~dp0haruneko-preview-data\\browser\\Cache"\r\n');
    await fs.writeFile(path.join(temporary, 'START-HERE.txt'), 'HaruNeko Enhanced Preview\r\nExtract the entire ZIP to a new writable folder. Run Start-HaruNeko-Enhanced-Preview.cmd. Do not pass custom data-directory flags.\r\nData stays in haruneko-preview-data next to this EXE. Do not copy original HakuNeko data.\r\nSQLite v11: older Previews may reject databases upgraded to v9 or later. Before upgrading an existing Preview profile, close the application and make a consistent backup of its entire data folder. Returning to an older Preview requires that earlier backup; never delete the database or edit its schema version to downgrade.\r\nWindows x64; unsigned experimental build. No automatic archiving. Limits: 5 manga, 20 chapter attempts, minimum reserve 50 GiB.\r\nSource commit: ' + build.commit + (build.dirty ? ' (DIRTY LOCAL TEST BUILD)' : '') + '\r\n');
    const name = `HaruNeko-Enhanced-Preview-${build.commit.slice(0, 12)}${build.dirty ? '-dirty' : ''}-win-x64-${Date.now()}.zip`;
    const target = path.join(build.output, name);
    const zip = new AdmZip(); zip.addLocalFolder(temporary); zip.writeZip(target);
    const digest = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    await fs.writeFile(target + '.sha256', `${digest}  ${name}\n`);
    console.log(JSON.stringify({ windowsPreview: target, sha256: digest, testedOnWindows: process.platform === 'win32' ? 'requires smoke test' : false }));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
