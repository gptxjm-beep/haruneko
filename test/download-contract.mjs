// Run from the repository root with a local Chromium installation.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer, loadConfigFromFile } from 'vite';
import puppeteer from 'puppeteer-core';

const root = path.resolve('web');
const { config } = await loadConfigFromFile({}, path.join(root, 'vite.config.ts'), root);
const server = await createServer({
    ...config, root, configFile: false,
    plugins: [...config.plugins, {
        name: 'local-download-contract',
        resolveId(id) { if (id === '/__contract-runtime') return '\0contract-runtime'; },
        load(id) { if (id === '\0contract-runtime') return "export { default as JSZip } from 'jszip';"; },
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                if (request.url !== '/__download-contract') return next();
                response.setHeader('Content-Type', 'text/html');
                response.end('<!doctype html><title>Isolated download contract tests</title>');
            });
        },
    }],
    server: { ...config.server, https: undefined, host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;
try {
    await server.listen();
    browser = await puppeteer.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__download-contract`);
    const results = await page.evaluate(async () => {
        const { DownloadManager } = await import('/src/engine/DownloadManager.ts');
        const { Manga, Chapter, Page } = await import('/src/engine/providers/MangaPlugin.ts');
        const { Key } = await import('/src/engine/SettingsGlobal.ts');
        const { JSZip } = await import('/__contract-runtime');
        const root = await navigator.storage.getDirectory();
        // A fresh temporary browser profile and origin own these files. No user directory is opened.
        const manual = await root.getDirectoryHandle('manual', { create: true });
        const archive = await root.getDirectoryHandle('archive', { create: true });
        const values = {
            [Key.MediaDirectory]: { Value: manual, EnsureAccess: async () => {} },
            [Key.MangaExportFormat]: { Value: 'image/*' },
            [Key.UseWebsiteSubDirectory]: { Value: true },
        };
        globalThis.HakuNeko = { SettingsManager: { OpenScope: () => ({ Get: key => values[key] }) } };
        const temporary = new Map();
        const storage = {
            SaveTemporary: async data => { const key = crypto.randomUUID(); temporary.set(key, data); return key; },
            LoadTemporary: async key => temporary.get(key),
            RemoveTemporary: async (...keys) => { for (const key of keys) temporary.delete(key); },
        };
        const canvas = new OffscreenCanvas(2, 2);
        canvas.getContext('2d').fillRect(0, 0, 2, 2);
        const image = await canvas.convertToBlob({ type: 'image/png' });
        const scraper = {
            FetchPages: async chapter => [new Page(scraper, chapter, new URL('https://example.invalid/local-page'))],
            FetchImage: async () => image.slice(0, image.size, 'text/html'),
        };
        const plugin = { Title: 'Site', Identifier: 'site', storageController: storage, Initialize: async () => {}, IsSameAs: other => other.Identifier === 'site' };
        const manga = new Manga(scraper, plugin, 'manga', 'Manga');
        const chapter = new Chapter(scraper, manga, 'chapter', 'Chapter 1');
        const manager = new DownloadManager(storage);
        const results = [];
        const record = (name, passed) => results.push({ name, passed });
        const manualTask = await manager.EnqueueTask(chapter);
        const archiveTask = await manager.EnqueueTask(chapter, { directory: archive, format: 'application/x-cbz', useWebsiteSubDirectory: false, owner: 'archive:one' });
        const [manualResult, archiveResult] = await Promise.all([manualTask.completion, archiveTask.completion]);
        record('Manual RAW and archive CBZ use independent destinations', manualResult.outcome === 'succeeded' && archiveResult.outcome === 'succeeded');
        record('Manual default path is unchanged', manualResult.output.files[0].path === 'Site/Manga/Chapter 1/1.png');
        record('Custom CBZ path is relative to its own root', archiveResult.output.files[0].path === 'Manga/Chapter 1.cbz');
        record('Input decoding is recorded separately from file readback', manualResult.inputValidation.state === 'passed' && manualResult.verification.state === 'passed');
        const rawFile = await manualResult.output.files[0].handle.getFile();
        const rawBytes = new Uint8Array(await rawFile.arrayBuffer());
        const originalBytes = new Uint8Array(await image.arrayBuffer());
        record('RAW preserves all original image bytes', rawBytes.length === originalBytes.length && rawBytes.every((value, index) => value === originalBytes[index]));
        const zip = await JSZip.loadAsync(await (await archiveResult.output.files[0].handle.getFile()).arrayBuffer());
        record('CBZ is readable and includes image and metadata', !!zip.file('1.png') && !!zip.file('ComicInfo.xml'));
        for (const format of ['application/epub+zip', 'application/pdf']) {
            const handle = await manager.EnqueueTask(chapter, { directory: archive, format, useWebsiteSubDirectory: false, owner: 'archive:formats' });
            const result = await handle.completion;
            record(`${format} closes and verifies its real output before completion`, result.outcome === 'succeeded' && result.output.files.length === 1 && result.verification.state === 'passed');
            if (result.outcome !== 'succeeded') throw new Error(`${format}: ${result.errors.map(item => item.error.message).join('; ')}`);
            const file = await result.output.files[0].handle.getFile();
            if (format === 'application/pdf') record('PDF has an end-of-file marker', (await file.text()).trimEnd().endsWith('%%EOF'));
            else record('EPUB package is readable', !!(await JSZip.loadAsync(await file.arrayBuffer())).file('OEBPS/content.opf'));
        }
        record('Global settings were not mutated', values[Key.MediaDirectory].Value === manual && values[Key.MangaExportFormat].Value === 'image/*' && values[Key.UseWebsiteSubDirectory].Value === true);
        record('Successful tasks clean only their temporary resources', temporary.size === 0);

        let active = 0;
        let peak = 0;
        let verifying = 0;
        let verificationOverlap = false;
        const originalCreateWritable = FileSystemFileHandle.prototype.createWritable;
        const originalGetFile = FileSystemFileHandle.prototype.getFile;
        FileSystemFileHandle.prototype.getFile = async function(...args) {
            verifying++;
            try {
                await new Promise(resolve => setTimeout(resolve, 30));
                return await originalGetFile.apply(this, args);
            } finally {
                verifying--;
            }
        };
        FileSystemFileHandle.prototype.createWritable = async function(...args) {
            verificationOverlap ||= verifying > 0;
            const stream = await originalCreateWritable.apply(this, args);
            peak = Math.max(peak, ++active);
            let released = false;
            const release = () => { if (!released) { released = true; active--; } };
            return {
                write: async data => { await new Promise(resolve => setTimeout(resolve, 30)); await stream.write(data); },
                close: async () => { try { await stream.close(); } finally { release(); } },
                abort: async reason => { try { await stream.abort(reason); } finally { release(); } },
            };
        };
        try {
            const firstManager = new DownloadManager(storage);
            const secondManager = new DownloadManager(storage);
            const handles = await Promise.all([
                firstManager.EnqueueTask(chapter, { directory: archive, format: 'image/*', owner: 'first', existingFiles: 'replace' }),
                secondManager.EnqueueTask(chapter, { directory: archive, format: 'image/*', owner: 'second', existingFiles: 'replace' }),
            ]);
            const attempts = await Promise.all(handles.map(handle => handle.completion));
            record('Independent managers serialize writes to the same physical output', peak === 1 && attempts.every(result => result.outcome === 'succeeded'));
            record('Output lock includes receipt readback before admitting another writer', !verificationOverlap);
        } finally {
            FileSystemFileHandle.prototype.createWritable = originalCreateWritable;
            FileSystemFileHandle.prototype.getFile = originalGetFile;
        }
        const remove = storage.RemoveTemporary;
        let cleanupHandle;
        storage.RemoveTemporary = async () => { throw new Error('Synthetic cleanup failure'); };
        try {
            cleanupHandle = await manager.EnqueueTask(chapter, { directory: archive, format: 'application/x-cbz', owner: 'cleanup-test', existingFiles: 'replace' });
            const result = await cleanupHandle.completion;
            record('Cleanup failure preserves a readable written CBZ receipt', result.outcome === 'succeeded-with-warnings' && result.output.state === 'written' && (await result.output.files[0].handle.getFile()).size === result.output.files[0].size && result.cleanup.state === 'failed');
        } finally {
            storage.RemoveTemporary = remove;
        }
        const retry = await cleanupHandle.retryCleanup();
        record('Cleanup-only retry removes its resources without a second export', retry.state === 'completed' && temporary.size === 0 && (await cleanupHandle.completion).cleanup.state === 'failed');
        return results;
    });
    for (const result of results) assert.equal(result.passed, true, result.name);
    console.log(`${results.length} filesystem download contract checks passed`);
} finally {
    await browser?.close();
    await server.close();
}
