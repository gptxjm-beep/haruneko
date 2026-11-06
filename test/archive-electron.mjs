import { rolldown } from 'rolldown';
import { createServer, loadConfigFromFile } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'haruneko-archive-electron-'));
const root = path.resolve('web');
const { config } = await loadConfigFromFile({}, path.join(root, 'vite.config.ts'), root);
const server = await createServer({ ...config, root, configFile: false,
    plugins: [...config.plugins, { name: 'archive-integration-page', configureServer(server) {
        server.middlewares.use((request, response, next) => {
            if (request.url !== '/__archive-integration') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><title>Isolated archive IPC test</title>');
        });
    } }], server: { ...config.server, https: undefined, host: '127.0.0.1', port: 0, strictPort: false } });
try {
    await server.listen();
    const bundle = await rolldown({ input: path.resolve('test/archive-electron-entry.mjs'), platform: 'node', external: id => id === 'electron' || id.startsWith('node:') });
    const entry = path.join(temporary, 'archive-app.mjs');
    await bundle.write({ file: entry, format: 'es' });
    await bundle.close();
    const env = { ...process.env,
        HARUNEKO_ARCHIVE_TEST_DIRECTORY: temporary,
        HARUNEKO_ARCHIVE_TEST_URL: `http://127.0.0.1:${server.httpServer.address().port}/__archive-integration`,
        HARUNEKO_ARCHIVE_TEST_PRELOAD: path.resolve('app/electron/build/preload.js'),
        HARUNEKO_ARCHIVE_TEST_SCRIPT: path.resolve('test/archive-electron-renderer.mjs'),
        HARUNEKO_ARCHIVE_UI_TEST_SCRIPT: path.resolve('test/archive-ui-renderer.mjs'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const executable = path.resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    const child = spawn(executable, ['--no-sandbox', entry], { env, stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Archive Electron test timed out')); }, 90_000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); resolve(code ?? 1); });
    });
} finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
}
