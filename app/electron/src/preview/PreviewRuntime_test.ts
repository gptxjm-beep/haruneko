import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { PreviewDataDirectory, VerifyPreview, ServePreview, PreviewOrigin, type PreviewManifest } from './PreviewRuntime';
async function Fixture() {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-preview-native-'));
    const app = path.join(base, 'resources/app'); await fs.mkdir(path.join(app, 'web'), { recursive: true });
    const content = '<title>Enhanced local UI</title>';
    await fs.writeFile(path.join(app, 'web/index.html'), content);
    const manifest: PreviewManifest = { schema: 1, commit: 'a'.repeat(40), dirty: true, electron: '45.2.2', assets: { 'index.html': createHash('sha256').update(content).digest('hex') } };
    await fs.writeFile(path.join(app, 'preview-manifest.json'), JSON.stringify(manifest));
    return { base, app, manifest, close: () => fs.rm(base, { recursive: true, force: true }) };
}
describe('Bundled Preview source boundary', () => {
    it('Should isolate portable data under the bundle rather than the original HakuNeko profile', () => {
        expect(PreviewDataDirectory(path.resolve('portable/resources/app'))).toBe(path.resolve('portable/haruneko-preview-data'));
        expect(PreviewDataDirectory(path.resolve('raw-app'))).toBe(path.resolve('raw-app/haruneko-preview-data'));
    });
    it('Should verify the local asset manifest and fail on changed or missing UI files', async () => {
        const f = await Fixture();
        try {
            expect((await VerifyPreview(f.app)).commit).toBe('a'.repeat(40));
            await fs.writeFile(path.join(f.app, 'web/index.html'), 'changed');
            await expect(VerifyPreview(f.app)).rejects.toThrow('missing or changed');
            await fs.unlink(path.join(f.app, 'web/index.html'));
            await expect(VerifyPreview(f.app)).rejects.toThrow();
        } finally { await f.close(); }
    });
    it('Should reject traversal in a supplied asset manifest', async () => {
        const f = await Fixture();
        try {
            f.manifest.assets['../private.txt'] = '0'.repeat(64);
            await fs.writeFile(path.join(f.app, 'preview-manifest.json'), JSON.stringify(f.manifest));
            await expect(VerifyPreview(f.app)).rejects.toThrow('Invalid preview asset');
        } finally { await f.close(); }
    });
    it('Should serve only verified local files, with no hosted UI fallback or data-directory route', async () => {
        const f = await Fixture(); let server: Awaited<ReturnType<typeof ServePreview>> | undefined;
        try {
            server = await ServePreview(f.app, await VerifyPreview(f.app));
            expect(await (await fetch(PreviewOrigin)).text()).toContain('Enhanced local UI');
            expect((await fetch(PreviewOrigin + '/haruneko-preview-data/profile')).status).toBe(404);
            expect((await fetch(PreviewOrigin + '/missing.js')).status).toBe(404);
            await fs.writeFile(path.join(f.app, 'web/index.html'), 'replacement');
            expect((await fetch(PreviewOrigin)).status).toBe(503);
        } finally { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); await f.close(); }
    });
});
