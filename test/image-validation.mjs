// Local browser regression checks; run from the repository root:
// BROWSER_EXECUTABLE_PATH=/usr/bin/chromium node test/image-validation.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer, loadConfigFromFile } from 'vite';
import puppeteer from 'puppeteer-core';

const root = path.resolve('web');
const { config } = await loadConfigFromFile({}, path.join(root, 'vite.config.ts'), root);
const server = await createServer({
    ...config,
    root,
    configFile: false,
    plugins: [...config.plugins, {
        name: 'local-image-validation-page',
        resolveId(id) {
            if (id === '/__viewer-runtime') return '\0viewer-runtime';
        },
        load(id) {
            if (id === '\0viewer-runtime') return "export { mount, unmount, tick } from 'svelte';";
        },
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                if (request.url !== '/__image-validation') return next();
                response.setHeader('Content-Type', 'text/html');
                response.end('<!doctype html><title>Local image validation tests</title>');
            });
        },
    }],
    server: { ...config.server, https: undefined, host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;
try {
    await server.listen();
    browser = await puppeteer.launch({
        executablePath: process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__image-validation`);
    const results = await page.evaluate(async () => {
        const { ValidateImage } = await import('/src/engine/ValidateImage.ts');
        const canvas = new OffscreenCanvas(2, 2);
        canvas.getContext('2d').fillRect(0, 0, 2, 2);
        const results = [];
        for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
            const original = await canvas.convertToBlob({ type });
            const originalBytes = new Uint8Array(await original.arrayBuffer());
            for (const declared of [type, 'application/octet-stream', 'text/html', '']) {
                const input = original.slice(0, original.size, declared);
                const output = await ValidateImage(input);
                const sameBytes = output.size === original.size && new Uint8Array(await output.arrayBuffer()).every((byte, index) => byte === originalBytes[index]);
                results.push({ name: `${type} declared ${declared}`, passed: output.type === type && sameBytes });
            }
        }
        const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>'], { type: 'image/svg+xml' });
        results.push({ name: 'SVG preserved', passed: await ValidateImage(svg) === svg });
        const png = await canvas.convertToBlob({ type: 'image/png' });
        const invalid = [
            new Blob(['<html>Error</html>'], { type: 'text/html' }),
            new Blob(['<html>Error</html>'], { type: 'image/png' }),
            png.slice(0, 8, 'image/png'),
            new Blob([], { type: 'image/png' }),
        ];
        for (const [index, input] of invalid.entries()) {
            let rejected = false;
            try { await ValidateImage(input); } catch { rejected = true; }
            results.push({ name: `Invalid payload ${index}`, passed: rejected });
        }
        const { Page } = await import('/src/engine/providers/MangaPlugin.ts');
        const { DownloadTask } = await import('/src/engine/DownloadTask.ts');
        async function download(payloads, failCleanup = false) {
            const saved = [];
            const cleaned = [];
            let exported = false;
            const entries = payloads.map(payload => new Page({ FetchImage: async () => payload }, null, new URL('https://example.invalid/image')));
            const media = {
                Entries: { Value: entries },
                Update: async () => {},
                Store: async () => { exported = true; },
            };
            const task = new DownloadTask(media, {
                SaveTemporary: async data => { saved.push(data); return `local-test-${saved.length}`; },
                RemoveTemporary: async (...keys) => {
                    cleaned.push(...keys);
                    if (failCleanup) throw new Error('Simulated cleanup failure');
                },
            });
            await task.Run();
            return { task, saved, cleaned, exported };
        }
        const valid = await download([png.slice(0, png.size, 'text/html')]);
        results.push({ name: 'Manual download accepts valid PNG with incorrect MIME', passed: valid.task.Status.Value === 'completed' && valid.exported && valid.saved[0].type === 'image/png' && valid.cleaned.length === 1 });
        const mixed = await download([png, invalid[0]]);
        results.push({ name: 'Invalid required page prevents chapter export', passed: mixed.task.Status.Value === 'failed' && !mixed.exported && mixed.saved.length === 1 && mixed.cleaned.length === 1 });
        const cleanup = await download([png], true);
        results.push({ name: 'Cleanup failure terminates task with its error', passed: cleanup.task.Status.Value === 'failed' && cleanup.exported && cleanup.task.Errors.Value[0].message === 'Simulated cleanup failure' });
        const { mount, unmount, tick } = await import('/__viewer-runtime');
        const { default: ImageViewer } = await import('/src/frontend/classic/components/viewer/Image.svelte');
        const target = document.createElement('div');
        document.body.append(target);
        let viewSignal;
        let finish;
        const unhandled = [];
        const onUnhandled = event => { unhandled.push(event.reason); };
        window.addEventListener('unhandledrejection', onUnhandled);
        const viewer = mount(ImageViewer, {
            target,
            props: {
                page: { Fetch: (_priority, signal) => {
                    viewSignal = signal;
                    return new Promise((resolve, reject) => {
                        finish = resolve;
                        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                    });
                } },
                alt: 'Local cancellation regression',
                wide: false,
            },
        });
        await tick();
        await unmount(viewer);
        results.push({ name: 'Viewer cancels pending image work on disposal', passed: viewSignal?.aborted === true });
        finish(svg);
        await tick();
        await new Promise(resolve => setTimeout(resolve, 10));
        results.push({ name: 'Viewer cancellation does not leave unhandled rejections', passed: unhandled.length === 0 });
        window.removeEventListener('unhandledrejection', onUnhandled);
        target.remove();
        return results;
    });
    for (const result of results) assert.equal(result.passed, true, result.name);
    console.log(`${results.length} browser image validation checks passed`);
} finally {
    await browser?.close();
    await server.close();
}
