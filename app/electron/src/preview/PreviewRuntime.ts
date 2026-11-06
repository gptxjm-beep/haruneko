import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const PreviewName = 'HaruNeko Enhanced Preview';
export const PreviewPort = 47831;
export const PreviewOrigin = `http://127.0.0.1:${PreviewPort}`;
export interface PreviewManifest { schema: 1; commit: string; dirty: boolean; electron: string; assets: Record<string, string> }
export function PreviewDataDirectory(appPath: string): string {
    const root = path.basename(appPath) === 'app' && path.basename(path.dirname(appPath)) === 'resources' ? path.resolve(appPath, '../..') : appPath;
    return path.join(root, 'haruneko-preview-data');
}
function SafeAsset(name: string): boolean { return !!name && !name.includes('\\') && !name.includes(':') && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..'); }
async function Hash(filename: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(filename)) hash.update(bytes);
    return hash.digest('hex');
}
export async function VerifyPreview(appPath: string): Promise<PreviewManifest> {
    const manifest = JSON.parse(await fs.readFile(path.join(appPath, 'preview-manifest.json'), 'utf8')) as PreviewManifest;
    if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit) || typeof manifest.dirty !== 'boolean' || !manifest.assets || !manifest.assets['index.html']) throw new Error('Invalid preview manifest');
    const root = await fs.realpath(path.join(appPath, 'web'));
    for (const [name, expected] of Object.entries(manifest.assets)) {
        if (!SafeAsset(name) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid preview asset');
        const file = path.join(root, name);
        const real = await fs.realpath(file);
        if (real !== file || !real.startsWith(root + path.sep) || !(await fs.stat(real)).isFile() || await Hash(real) !== expected) throw new Error('Bundled preview files are missing or changed');
    }
    return manifest;
}
const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
/** Stable loopback origin preserves IndexedDB across launches. Never loads a hosted fallback or serves user data. */
export async function ServePreview(appPath: string, manifest: PreviewManifest): Promise<Server> {
    const root = await fs.realpath(path.join(appPath, 'web'));
    const server = createServer(async (request, response) => {
        try {
            if (request.headers.host !== `127.0.0.1:${PreviewPort}`) { response.writeHead(421).end(); return; }
            if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return; }
            const pathname = decodeURIComponent(new URL(request.url ?? '/', PreviewOrigin).pathname);
            const name = pathname === '/' ? 'index.html' : pathname.slice(1);
            if (!SafeAsset(name) || !Object.hasOwn(manifest.assets, name)) { response.writeHead(404).end(); return; }
            const file = path.join(root, name);
            if (await fs.realpath(file) !== file || await Hash(file) !== manifest.assets[name]) throw new Error('Preview asset changed');
            response.writeHead(200, { 'Content-Type': types[path.extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            if (request.method === 'HEAD') response.end(); else createReadStream(file).on('error', () => response.destroy()).pipe(response);
        } catch { response.writeHead(503).end('Preview files unavailable. Re-extract the verified bundle.'); }
    });
    server.on('connection', socket => socket.unref());
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(PreviewPort, '127.0.0.1', resolve); });
    server.unref(); // The local UI server must not keep an otherwise closed Electron app alive.
    return server;
}
