import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { ArchiveRepository } from './ArchiveRepository';
import { ArchiveFiles } from './ArchiveFiles';
import { ArchiveStorageSafety, ProbeArchiveVolume } from './ArchiveStorageSafety';
import { ArchiveStorageController } from './ArchiveStorageController';

const GiB = 1024n ** 3n;
const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of close.splice(0)) await action(); });

async function fixture() {
    // The injected capacity map must use native physical paths, as the production grants do.
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-storage-safety-')));
    const root = path.join(base, 'output');
    const profile = path.join(base, 'profile');
    const browser = path.join(base, 'browser');
    const scratch = path.join(base, 'scratch');
    await Promise.all([root, profile, browser, scratch].map(directory => fs.mkdir(directory)));
    await fs.writeFile(path.join(root, 'old-user.cbz'), 'existing-user-archive');
    const repository = new ArchiveRepository(path.join(profile, 'state.sqlite'));
    const rootId = repository.GrantRoot(root).rootId;
    const paths = { profile, browser, scratch, staging: repository.StagingDirectory };
    const space = new Map<string, bigint>();
    const faults = new Map<string, Error>();
    const safety = new ArchiveStorageSafety(undefined, async directory => {
        if (faults.has(directory)) throw faults.get(directory);
        const info = await fs.stat(directory, { bigint: true });
        const usable = space.get(directory) ?? 1024n * GiB;
        return { volume: directory, identity: `${info.dev}:${info.ino}`, usableBytes: usable, freeBytes: usable };
    });
    const storage = new ArchiveStorageController(repository, paths, safety);
    const files = new ArchiveFiles(repository, undefined, storage);
    const session = repository.CreateSession(rootId, 'site', 'Site', { format: 'application/x-cbz', useWebsiteSubDirectory: false });
    const chapter = repository.RegisterChapter(session, { siteId: 'site', mangaId: 'manga', chapterId: 'chapter', title: 'Chapter', position: 0, orderConfidence: 'unknown', orderEvidence: '' });
    const attempt = repository.BeginAttempt(session, chapter);
    repository.Checkpoint(attempt, 'export', 1, 1, 1);
    close.push(async () => {
        try { await files.Close(); expect(await fs.readFile(path.join(root, 'old-user.cbz'), 'utf8')).toBe('existing-user-archive'); }
        finally { repository.Close(); await fs.rm(base, { recursive: true, force: true }); }
    });
    return { root, paths, repository, storage, files, session, chapter, attempt, space, faults,
        async begin() { return files.Begin(attempt, 'chapter.cbz', 4); },
    };
}

describe('Archive storage and isolated native writes', () => {
    it('Should obtain actual asynchronous filesystem free and usable values', async () => {
        const f = await fixture();
        const sample = await ProbeArchiveVolume(f.root);
        expect(typeof sample.usableBytes).toBe('bigint');
        expect(sample.freeBytes >= sample.usableBytes).toBe(true);
        await f.storage.CheckSession(f.session);
    });

    it('Should stop for a low staging disk even when the output disk has enough space', async () => {
        const f = await fixture();
        f.space.set(f.paths.staging, 49n * GiB);
        await expect(f.begin()).rejects.toMatchObject({ Fault: { code: 'low-space', location: 'staging' } });
        expect(await fs.readdir(f.paths.staging)).toEqual([]);
    });

    it('Should reject browser quota exhaustion independently of physical capacity', async () => {
        const f = await fixture();
        await expect(f.storage.Image(f.attempt, 4096, { usage: 0, quota: 1024 })).rejects.toMatchObject({ Fault: { code: 'quota-exceeded' } });
        await f.storage.Image(f.attempt, 4096, { usage: 0, quota: 1024 ** 3 });
    });

    it('Should grow the estimate when output preparation exceeds its initial input estimate', async () => {
        const f = await fixture();
        await f.storage.Image(f.attempt, 4096, { usage: 0, quota: 1024 ** 3 });
        f.space.set(f.root, 50n * GiB + 100n * 1024n ** 2n);
        await expect(f.storage.Prepare(f.attempt, 100 * 1024 ** 2)).rejects.toMatchObject({ Fault: { code: 'low-space' } });
    });

    it('Should stop a new chunk when available space fell after the write began', async () => {
        const f = await fixture();
        const token = await f.begin();
        f.space.set(f.root, 49n * GiB);
        await expect(f.files.Chunk(token, new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ Fault: { code: 'low-space' } });
        await f.files.Abort(token);
        f.space.set(f.root, 1024n * GiB);
        expect((await f.files.Recover(f.session, f.chapter)).action).toBe('retry-missing');
    });

    it('Should not release an active writer reservation when a duplicate writer is rejected', async () => {
        const f = await fixture();
        const token = await f.begin();
        await expect(f.begin()).rejects.toThrow('active writer');
        const almostAll = 1024n * GiB - 50n * GiB - 64n * 1024n ** 2n - 2n;
        await expect(f.storage.Safety.Reserve('competitor', [{ slot: 'output', path: f.root, location: 'archive', bytes: almostAll }])).rejects.toMatchObject({ Fault: { code: 'low-space' } });
        await f.files.Abort(token);
        await f.storage.Safety.Reserve('competitor', [{ slot: 'output', path: f.root, location: 'archive', bytes: almostAll }]);
        await f.storage.Safety.Release('competitor');
    });

    it('Should retain a complete staged file when publication is blocked, then publish it after space is restored', async () => {
        const f = await fixture();
        const token = await f.begin();
        await f.files.Chunk(token, new Uint8Array([1, 2, 3, 4]));
        f.space.set(f.root, 49n * GiB);
        await expect(f.files.Finish(token)).rejects.toMatchObject({ Fault: { code: 'low-space' } });
        const recovered = await f.files.Recover(f.session, f.chapter);
        expect(recovered.action).toBe('publish-staged');
        expect(f.repository.Chapter(f.session, f.chapter).state).not.toBe('Completed');
        f.space.set(f.root, 1024n * GiB);
        await f.files.Publish(recovered.files[0].fileId);
        expect((await f.files.Recover(f.session, f.chapter)).action).toBe('reuse');
    });

    it('Should report actual ENOSPC and preserve a nonempty partial staging file', async () => {
        const f = await fixture();
        const token = await f.begin();
        const writes = (f.files as unknown as { writes: Map<string, { handle: FileHandle }> }).writes;
        const handle = writes.get(token)!.handle;
        const original = handle.write.bind(handle);
        vi.spyOn(handle, 'write').mockImplementationOnce(async () => {
            await original(new Uint8Array([1, 2]));
            throw Object.assign(new Error('Disk full during write'), { code: 'ENOSPC' });
        });
        await expect(f.files.Chunk(token, new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ Fault: { code: 'write-full' } });
        await f.files.Abort(token);
        expect((await f.files.Recover(f.session, f.chapter)).action).toBe('review');
        expect(f.repository.Chapter(f.session, f.chapter).state).not.toBe('Completed');
        expect((await fs.readdir(f.paths.staging)).length).toBe(1);
    });

    it('Should fail closed for measurement and permission errors', async () => {
        const f = await fixture();
        f.faults.set(f.root, new Error('No statfs support'));
        await expect(f.storage.CheckSession(f.session)).rejects.toMatchObject({ Fault: { code: 'unmeasurable' } });
        f.faults.set(f.root, Object.assign(new Error('Permissions changed'), { code: 'EACCES' }));
        await expect(f.storage.CheckSession(f.session)).rejects.toMatchObject({ Fault: { code: 'permission-denied' } });
    });

    it('Should distinguish a disconnected archive from a changed directory', async () => {
        const f = await fixture();
        const offline = f.root + '-offline';
        await fs.rename(f.root, offline);
        try {
            await expect(f.storage.CheckSession(f.session)).rejects.toMatchObject({ Fault: { code: 'disconnected' } });
            await fs.mkdir(f.root);
            await expect(f.storage.CheckSession(f.session)).rejects.toMatchObject({ Fault: { code: 'destination-changed' } });
            await fs.rmdir(f.root);
        } finally { await fs.rename(offline, f.root); }
    });

    it('Should refuse an unknown existing archive without replacing it', async () => {
        const f = await fixture();
        await expect(f.files.Begin(f.attempt, 'old-user.cbz', 4)).rejects.toThrow('replacement is forbidden');
    });
});
