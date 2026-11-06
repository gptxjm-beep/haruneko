import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import native from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResolveArchivePath, Fingerprint } from './ArchivePaths';
import { ArchiveRepository } from './ArchiveRepository';
import { ArchiveFiles } from './ArchiveFiles';
import { ProbeArchiveVolume } from './ArchiveStorageSafety';
async function Fixture() {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-windows-path-'));
    const root = path.join(base, 'MiXeD Archive Root'); await fs.mkdir(root);
    const repository = new ArchiveRepository(path.join(base, 'profile', 'state.sqlite'));
    const files = new ArchiveFiles(repository);
    return { base, root, repository, files, async Close() { await files.Close(); repository.Close(); await fs.rm(base, { recursive: true, force: true }); } };
}
function Attempt(f: Awaited<ReturnType<typeof Fixture>>, rootId: string, chapterId = 'chapter') {
    const session = f.repository.CreateSession(rootId, 'site', 'Site', { format: 'application/x-cbz', useWebsiteSubDirectory: false });
    const chapter = f.repository.RegisterChapter(session, { siteId: 'site', mangaId: 'manga', chapterId, title: 'Chapter', position: 0, orderConfidence: 'unknown', orderEvidence: '' });
    const attempt = f.repository.BeginAttempt(session, chapter);
    f.repository.Checkpoint(attempt, 'export', 1, 1, 1);
    return attempt;
}
describe('Archive directory spelling and physical identity', () => {
    it('Should accept an equivalent directory spelling without dropping physical or containment checks', async () => {
        const f = await Fixture();
        try {
            const alias = f.root + path.sep + '.';
            const output = await ResolveArchivePath(alias, 'Manga/chapter.cbz', true);
            expect(output).toBe(path.join(await fs.realpath(f.root), 'Manga/chapter.cbz'));
        } finally { await f.Close(); }
    });
    it.skipIf(process.platform !== 'win32')('Should publish, verify and recover a Windows mixed-case grant using native real paths', async () => {
        const f = await Fixture();
        try {
            const input = f.root.toUpperCase(); // Test input variant only; never a security comparison.
            const js = native.realpathSync(input); const sync = native.realpathSync.native(input); const asyncPath = await fs.realpath(input);
            const before = await fs.stat(input, { bigint: true }); const actual = await fs.stat(asyncPath, { bigint: true });
            console.log(JSON.stringify({ test: 'windows-path-spelling', javascriptEqualsNative: js === sync, nativeSyncEqualsAsync: sync === asyncPath, inputEqualsAsync: input === asyncPath, sameDevice: before.dev === actual.dev, sameDirectory: before.ino === actual.ino }));
            const rootId = f.repository.GrantRoot(input).rootId;
            expect(f.repository.RootPath(rootId)).toBe(sync);
            expect(f.repository.GrantRoot(f.root).rootId).toBe(rootId);
            expect((await ProbeArchiveVolume(input)).identity).toBe(f.repository.RootStorageIdentity(rootId));
            const attempt = Attempt(f, rootId);
            const token = await f.files.Begin(attempt, 'Manga/chapter.cbz', 4);
            await f.files.Chunk(token, Buffer.from('data'));
            const receipt = await f.files.Finish(token);
            expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
            expect((await Fingerprint(f.repository.VerifyRoot(rootId), receipt.path)).sha256).toBe(receipt.sha256);
            const conflict = Attempt(f, rootId, 'another-chapter');
            await expect(f.files.Begin(conflict, 'Manga/chapter.cbz', 4)).rejects.toThrow('replacement is forbidden');
            expect(await fs.readFile(path.join(f.root, receipt.path), 'utf8')).toBe('data');
        } finally { await f.Close(); }
    });
    it('Should reject a replaced directory and preserve an unrelated existing archive', async () => {
        const f = await Fixture();
        try {
            const grant = f.repository.GrantRoot(f.root);
            await fs.rename(f.root, f.root + '-old'); await fs.mkdir(f.root);
            await fs.writeFile(path.join(f.root, 'existing.cbz'), 'old-user-data');
            expect(() => f.repository.VerifyRoot(grant.rootId)).toThrow('identity changed');
            await expect(f.files.Begin(Attempt(f, grant.rootId), 'new.cbz', 1)).rejects.toThrow('identity changed');
            expect(await fs.readFile(path.join(f.root, 'existing.cbz'), 'utf8')).toBe('old-user-data');
        } finally { await f.Close(); }
    });
    it('Should reuse an identity-checked legacy root spelling and preserve existing output bytes', async () => {
        const f = await Fixture();
        try {
            const rootId = f.repository.GrantRoot(f.root).rootId;
            f.repository['database'].prepare('UPDATE roots SET path=? WHERE id=?').run(f.root + path.sep + '.', rootId);
            expect(f.repository.GrantRoot(f.root).rootId).toBe(rootId);
            expect(f.repository.VerifyRoot(rootId)).toBe(await fs.realpath(f.root));
            const attempt = Attempt(f, rootId);
            const token = await f.files.Begin(attempt, 'legacy.cbz', 4);
            await f.files.Chunk(token, Buffer.from('data')); await f.files.Finish(token);
            const next = Attempt(f, rootId);
            const reuse = await f.files.Begin(next, 'legacy.cbz', 4);
            await f.files.Chunk(reuse, Buffer.from('data'));
            expect((await f.files.Finish(reuse)).reused).toBe(true);
            expect(await fs.readFile(path.join(f.root, 'legacy.cbz'), 'utf8')).toBe('data');
        } finally { await f.Close(); }
    });
    it('Should reject root links and nested junction/symlink escapes', async () => {
        const f = await Fixture();
        try {
            const outside = path.join(f.base, 'outside'); await fs.mkdir(outside);
            const link = path.join(f.base, 'root-link');
            await fs.symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
            await expect(ResolveArchivePath(link, 'x.cbz')).rejects.toThrow();
            await fs.symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
            await expect(ResolveArchivePath(f.root, 'escape/x.cbz', true)).rejects.toThrow('Unsafe archive parent');
            expect(await fs.readdir(outside)).toEqual([]);
        } finally { await f.Close(); }
    });
});
