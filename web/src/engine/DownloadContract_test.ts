import { describe, expect, it, vi } from 'vitest';
import { DownloadTask, Status } from './DownloadTask';
import { DownloadManager } from './DownloadManager';
import type { DownloadOptions, StoreOptions } from './DownloadContract';
import type { StoreableMediaContainer, MediaItem } from './providers/MediaPlugin';
import type { StorageController } from './StorageController';
import { WithOutputLock } from './exporters/OutputLock';
import { WriteExportFile } from './exporters/WriteExportFile';
import { ImageValidationError } from './ValidateImage';

function fixture() {
    const data = new Blob(['validated page']);
    const file = { getFile: vi.fn().mockResolvedValue(data) } as unknown as FileSystemFileHandle;
    const item = { Fetch: vi.fn().mockResolvedValue(data) };
    const media = {
        Identifier: 'chapter', Entries: { Value: [item] }, Update: vi.fn().mockResolvedValue(undefined),
        IsSameAs: (other: { Identifier: string }) => other.Identifier === 'chapter',
        Store: vi.fn(async (_resources: Map<number, string>, options?: StoreOptions) => {
            options?.context.begin(1);
            options?.context.writing('chapter.cbz');
            options?.context.written({ path: 'chapter.cbz', size: data.size, handle: file });
        }),
    };
    const storage = { SaveTemporary: vi.fn().mockResolvedValue('owned-key'), RemoveTemporary: vi.fn().mockResolvedValue(undefined) };
    return {
        media, storage, file, item, data,
        task: (options?: DownloadOptions) => new DownloadTask(media as unknown as StoreableMediaContainer<MediaItem>, storage as unknown as StorageController, options),
        manager: () => new DownloadManager(storage as unknown as StorageController),
        container: media as unknown as StoreableMediaContainer<MediaItem>,
    };
}

function directory(id: string): FileSystemDirectoryHandle {
    return {
        name: id,
        isSameEntry: async other => other.name === id,
        resolve: async other => other.name === id ? [] : null,
    } as FileSystemDirectoryHandle;
}

describe('Download attempt contract', () => {
    it('Should cancel a paced archive without waiting for the next long request delay', async () => {
        vi.useFakeTimers();
        try {
            const f = fixture();
            f.media.Entries.Value = [f.item, f.item];
            const task = f.task({ pageDelayMs: 60_000, archiveTarget: { identity: 'archive', rootId: 'root', format: 'application/x-cbz', useWebsiteSubDirectory: false,
                checkpoint: async () => {}, beginExport: async () => {}, write: async () => { throw new Error('Cancelled before export'); } } });
            const running = task.Run();
            let settled = false;
            task.Handle.completion.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(100);
            task.Handle.cancel('Caller cancelled archive');
            await vi.advanceTimersByTimeAsync(50);
            expect(settled).toBe(true);
            expect(f.item.Fetch).toHaveBeenCalledTimes(1);
            await running;
        } finally { await vi.runAllTimersAsync(); vi.useRealTimers(); }
    });
    it('Should pace archive pages serially and call the temporary capacity checkpoint', async () => {
        const f = fixture();
        const starts: number[] = [];
        let active = 0;
        let maximum = 0;
        const fetch = async () => {
            starts.push(Date.now()); maximum = Math.max(maximum, ++active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--; return f.data;
        };
        f.media.Entries.Value = [{ Fetch: vi.fn(fetch) }, { Fetch: vi.fn(fetch) }, { Fetch: vi.fn(fetch) }];
        f.media.Store.mockImplementation(async (_resources, options) => {
            await options.context.begin(1);
            options.context.written({ path: 'chapter.cbz', size: f.data.size, rootId: 'root', fileId: 'file', sha256: 'a'.repeat(64) });
        });
        const beforeTemporaryWrite = vi.fn().mockResolvedValue(undefined);
        const task = f.task({ pageDelayMs: 100, beforeTemporaryWrite, archiveTarget: { identity: 'archive', rootId: 'root', format: 'application/x-cbz', useWebsiteSubDirectory: false,
            checkpoint: async () => {}, beginExport: async () => {}, write: async () => { throw new Error('Not used by fixture'); } } });
        await task.Run();
        expect((await task.Handle.completion).outcome).toBe('succeeded');
        expect(maximum).toBe(1);
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(80);
        expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(80);
        expect(beforeTemporaryWrite).toHaveBeenCalledTimes(3);
    });
    it('Should resolve with separately verified write and cleanup receipts', async () => {
        const f = fixture();
        const task = f.task();
        const handle = task.Handle;
        await task.Run();
        const result = await handle.completion;
        expect(result.outcome).toBe('succeeded');
        expect(result.fetch).toMatchObject({ state: 'succeeded', expectedPages: 1, receivedPages: 1, sourceCompleteness: 'unknown' });
        expect(result.output).toMatchObject({ state: 'written', expectedFiles: 1, files: [{ path: 'chapter.cbz', size: f.data.size }] });
        expect(result.verification).toEqual({ state: 'passed', method: 'file-size' });
        expect(result.cleanup).toEqual({ state: 'completed', remainingKeys: [] });
        expect(result.errors).toEqual([]);
    });

    it('Should keep fetch failure distinct from export failure', async () => {
        const f = fixture();
        f.item.Fetch.mockRejectedValue(new Error('Image fetch failed'));
        const task = f.task();
        await task.Run();
        const result = await task.Handle.completion;
        expect(result.outcome).toBe('failed');
        expect(result.fetch.state).toBe('failed');
        expect(result.output.state).toBe('not-started');
        expect(result.errors[0].stage).toBe('fetch');
        expect(f.media.Store).not.toHaveBeenCalled();
    });

    it('Should distinguish an invalid image from an HTTP fetch failure', async () => {
        const f = fixture();
        f.item.Fetch.mockRejectedValue(new ImageValidationError('HTML instead of an image'));
        const task = f.task();
        await task.Run();
        const result = await task.Handle.completion;
        expect(result.inputValidation.state).toBe('failed');
        expect(result.errors[0].stage).toBe('validation');
        expect(result.output.state).toBe('not-started');
    });

    it('Should preserve successful fetch separately from temporary storage failure', async () => {
        const f = fixture();
        f.storage.SaveTemporary.mockRejectedValue(new Error('Temporary storage full'));
        const task = f.task();
        await task.Run();
        const result = await task.Handle.completion;
        expect(result.fetch).toMatchObject({ state: 'succeeded', receivedPages: 1 });
        expect(result.outcome).toBe('failed');
        expect(result.errors[0].stage).toBe('temporary-storage');
        expect(f.media.Store).not.toHaveBeenCalled();
    });

    it('Should preserve the written receipt when export subsequently fails', async () => {
        const f = fixture();
        f.media.Store.mockImplementation(async (_, options) => {
            options.context.begin(2);
            options.context.written({ path: 'chapter/1.png', size: f.data.size, handle: f.file });
            throw new Error('Second file failed');
        });
        const task = f.task();
        await task.Run();
        const result = await task.Handle.completion;
        expect(result.outcome).toBe('failed');
        expect(result.output.state).toBe('partial');
        expect(result.output.files).toHaveLength(1);
        expect(result.errors[0].stage).toBe('export');
    });

    it('Should report successful writing with a separate cleanup warning, without refetching', async () => {
        const f = fixture();
        f.storage.RemoveTemporary.mockRejectedValue(new Error('Cleanup failed'));
        const task = f.task();
        await task.Run();
        const result = await task.Handle.completion;
        expect(result.outcome).toBe('succeeded-with-warnings');
        expect(result.output.state).toBe('written');
        expect(result.verification.state).toBe('passed');
        expect(result.cleanup).toEqual({ state: 'failed', remainingKeys: ['owned-key'] });
        expect(result.errors.map(error => error.stage)).toEqual(['cleanup']);
        expect(f.item.Fetch).toHaveBeenCalledTimes(1);
        expect(task.Status.Value).toBe(Status.Failed); // Legacy UI remains conservative.
    });

    it('Should retry only owned cleanup keys without changing the completed attempt receipt', async () => {
        const f = fixture();
        f.storage.RemoveTemporary.mockRejectedValueOnce(new Error('Cleanup temporarily unavailable'));
        const task = f.task();
        const handle = task.Handle;
        await task.Run();
        const receipt = await handle.completion;
        const retry = await handle.retryCleanup();
        expect(retry).toMatchObject({ attemptId: receipt.attemptId, state: 'completed', remainingKeys: [], errors: [] });
        expect(f.storage.RemoveTemporary.mock.calls).toEqual([['owned-key'], ['owned-key']]);
        expect(f.item.Fetch).toHaveBeenCalledTimes(1);
        expect(f.media.Store).toHaveBeenCalledTimes(1);
        expect(receipt.cleanup.state).toBe('failed');
        await handle.retryCleanup();
        expect(f.storage.RemoveTemporary).toHaveBeenCalledTimes(2);
    });

    it('Should publish export progress and staged errors to handle subscribers', async () => {
        const f = fixture();
        f.storage.RemoveTemporary.mockRejectedValueOnce(new Error('Cleanup failed'));
        const task = f.task();
        const states: string[] = [];
        const errors: string[] = [];
        task.Handle.exportProgress.Subscribe(value => states.push(value.state));
        task.Handle.errors.Subscribe(value => errors.push(...value.map(item => item.stage)));
        await task.Run();
        expect(states).toContain('preparing');
        expect(states).toContain('writing');
        expect(states.at(-1)).toBe('written');
        expect(errors).toEqual(['cleanup']);
    });

    it('Should distinguish readback failure from successful writing', async () => {
        const f = fixture();
        vi.mocked(f.file.getFile).mockResolvedValue(new Blob([]) as File);
        const task = f.task();
        await task.Run();
        const result = await task.Handle.completion;
        expect(result.output.state).toBe('written');
        expect(result.verification.state).toBe('failed');
        expect(result.outcome).toBe('failed');
        expect(result.errors[0].stage).toBe('verification');
    });

    it('Should not claim an opaque legacy Store produced a verified artifact', async () => {
        const f = fixture();
        f.media.Store.mockResolvedValue(undefined);
        const task = f.task();
        await task.Run();
        expect(task.Status.Value).toBe(Status.Completed);
        const result = await task.Handle.completion;
        expect(result.outcome).toBe('unverified');
        expect(result.output.state).toBe('unknown');
    });

    it('Should settle queued cancellation without starting a stale selected task', async () => {
        const f = fixture();
        const task = f.task();
        const handle = task.Handle;
        handle.cancel();
        await task.Run();
        expect((await handle.completion).outcome).toBe('cancelled');
        expect(f.media.Update).not.toHaveBeenCalled();
        expect(f.storage.RemoveTemporary).not.toHaveBeenCalled();
    });

    it('Should stop a cancelled download before temporary saving or export', async () => {
        const f = fixture();
        let release: (data: Blob) => void;
        f.item.Fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const task = f.task();
        const running = task.Run();
        await vi.waitFor(() => expect(f.item.Fetch).toHaveBeenCalled());
        task.Handle.cancel();
        release(f.data); // Even a provider ignoring AbortSignal cannot trigger an export.
        await running;
        expect((await task.Handle.completion).outcome).toBe('cancelled');
        expect(f.storage.SaveTemporary).not.toHaveBeenCalled();
        expect(f.media.Store).not.toHaveBeenCalled();
    });

    it('Should retain partial output on cancellation during export', async () => {
        const f = fixture();
        f.media.Store.mockImplementation(async (_, options) => {
            options.context.begin(2);
            options.context.written({ path: '1.png', size: f.data.size, handle: f.file });
            await new Promise((_, reject) => options.context.signal.addEventListener('abort', () => reject(options.context.signal.reason), { once: true }));
        });
        const task = f.task();
        const running = task.Run();
        await vi.waitFor(() => expect(f.media.Store).toHaveBeenCalled());
        task.Handle.cancel();
        await running;
        const result = await task.Handle.completion;
        expect(result.outcome).toBe('cancelled');
        expect(result.output.state).toBe('partial');
        expect(result.output.files[0].handle).toBe(f.file);
    });

    it('Should keep completed output if cancellation arrives after its final close', async () => {
        const f = fixture();
        const task = f.task();
        const store = f.media.Store.getMockImplementation();
        f.media.Store.mockImplementation(async (resources, options) => {
            await store(resources, options);
            task.Handle.cancel();
        });
        await task.Run();
        const result = await task.Handle.completion;
        expect(result.cancellationRequested).toBe(true);
        expect(result.output.state).toBe('written');
        expect(result.outcome).toBe('succeeded');
    });

    it('Should isolate results and completion promises across explicit attempts', async () => {
        const f = fixture();
        f.item.Fetch.mockRejectedValueOnce(new Error('First attempt failed'));
        const task = f.task();
        const first = task.Handle;
        await task.Run();
        const previous = await first.completion;
        await task.Run();
        const next = await task.Handle.completion;
        expect(previous.outcome).toBe('failed');
        expect(next.outcome).toBe('succeeded');
        expect(previous.attemptId).not.toBe(next.attemptId);
        expect(await first.completion).toBe(previous);
        expect(previous.errors).toHaveLength(1);
        expect(next.errors).toHaveLength(0);
    });

    it('Should not let an old handle cancel or observe a new attempt', async () => {
        const f = fixture();
        const task = f.task();
        const first = task.Handle;
        await task.Run();
        const prior = await first.completion;
        let release: (data: Blob) => void;
        f.item.Fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const running = task.Run();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        first.cancel();
        expect(first.status.Value).toBe(Status.Completed);
        expect(task.Handle.status.Value).toBe(Status.Downloading);
        release(f.data);
        await running;
        expect((await task.Handle.completion).outcome).toBe('succeeded');
        expect(await first.completion).toBe(prior);
    });

    it('Should settle the original promise when a status subscriber starts a retry', async () => {
        const f = fixture();
        const task = f.task();
        const first = task.Handle;
        let retried = false;
        let retry: Promise<void>;
        task.Status.Subscribe(status => {
            if (status === Status.Completed && !retried) {
                retried = true;
                retry = task.Run();
            }
        });
        await task.Run();
        expect((await first.completion).attemptId).toBe(first.attemptId);
        await retry;
        expect((await task.Handle.completion).attemptId).not.toBe(first.attemptId);
    });

    it('Should settle even when the media accessor unexpectedly throws', async () => {
        const f = fixture();
        Object.defineProperty(f.media, 'Entries', { get() { throw new Error('Unexpected accessor error'); } });
        const task = f.task();
        await expect(task.Run()).resolves.toBeUndefined();
        expect((await task.Handle.completion).outcome).toBe('failed');
    });
});

describe('Export writer commit boundary', () => {
    it('Should preserve an existing output when the archive policy forbids replacement', async () => {
        const stream = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
        const existing = { createWritable: vi.fn().mockResolvedValue(stream) };
        const directory = { getFileHandle: vi.fn().mockResolvedValue(existing) } as unknown as FileSystemDirectoryHandle;
        const context = { signal: new AbortController().signal, existingFiles: 'preserve' as const, begin: vi.fn(), writing: vi.fn(), written: vi.fn() };
        await expect(WriteExportFile(directory, 'same-name.cbz', new Blob(['replacement']), context)).rejects.toThrow('already exists');
        expect(existing.createWritable).not.toHaveBeenCalled();
    });
    it('Should not issue a receipt before close completes', async () => {
        let close: () => void;
        const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn(() => new Promise<void>(resolve => { close = resolve; })), abort: vi.fn().mockResolvedValue(undefined) };
        const file = { createWritable: async () => stream } as unknown as FileSystemFileHandle;
        const directory = { getFileHandle: async () => file } as unknown as FileSystemDirectoryHandle;
        const context = { signal: new AbortController().signal, begin: vi.fn(), writing: vi.fn(), written: vi.fn() };
        const writing = WriteExportFile(directory, 'chapter.cbz', new Blob(['data']), context);
        await vi.waitFor(() => expect(close).toBeTypeOf('function'));
        expect(context.written).not.toHaveBeenCalled();
        close();
        await writing;
        expect(context.written).toHaveBeenCalledWith({ path: 'chapter.cbz', size: 4, handle: file });
    });

    it('Should abort the writable instead of closing a partial write on failure', async () => {
        const error = new Error('Disk write failed');
        const stream = { write: vi.fn().mockRejectedValue(error), close: vi.fn(), abort: vi.fn().mockResolvedValue(undefined) };
        const directory = { getFileHandle: async () => ({ createWritable: async () => stream }) } as unknown as FileSystemDirectoryHandle;
        const context = { signal: new AbortController().signal, begin: vi.fn(), writing: vi.fn(), written: vi.fn() };
        await expect(WriteExportFile(directory, 'chapter.cbz', new Blob(['data']), context)).rejects.toBe(error);
        expect(stream.close).not.toHaveBeenCalled();
        expect(stream.abort).toHaveBeenCalledWith(error);
        expect(context.written).not.toHaveBeenCalled();
    });

    it('Should not report a failed close as a completed artifact', async () => {
        const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockRejectedValue(new Error('Close failed')), abort: vi.fn().mockResolvedValue(undefined) };
        const directory = { getFileHandle: async () => ({ createWritable: async () => stream }) } as unknown as FileSystemDirectoryHandle;
        const context = { signal: new AbortController().signal, begin: vi.fn(), writing: vi.fn(), written: vi.fn() };
        await expect(WriteExportFile(directory, 'chapter.cbz', new Blob(['data']), context)).rejects.toThrow('Close failed');
        expect(context.written).not.toHaveBeenCalled();
    });

    it('Should abort rather than commit when cancelled during a write', async () => {
        let release: () => void;
        const stream = { write: vi.fn(() => new Promise<void>(resolve => { release = resolve; })), close: vi.fn(), abort: vi.fn().mockResolvedValue(undefined) };
        const directory = { getFileHandle: async () => ({ createWritable: async () => stream }) } as unknown as FileSystemDirectoryHandle;
        const controller = new AbortController();
        const context = { signal: controller.signal, begin: vi.fn(), writing: vi.fn(), written: vi.fn() };
        const writing = WriteExportFile(directory, 'chapter.cbz', new Blob(['data']), context);
        const rejected = expect(writing).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        controller.abort();
        release();
        await rejected;
        expect(stream.close).not.toHaveBeenCalled();
        expect(stream.abort).toHaveBeenCalled();
        expect(context.written).not.toHaveBeenCalled();
    });
});

describe('DownloadManager handle API', () => {
    it('Should release a large batch of completed archive tasks while preserving handles and manual history', async () => {
        const f = fixture();
        const manager = f.manager();
        await manager.Enqueue(f.container);
        const manual = manager.Queue.Value[0];
        await manual.Handle.completion;
        const handles = [];
        for (let index = 0; index < 500; index++) {
            const handle = await manager.EnqueueTask(f.container, { owner: `archive:${index}` });
            handles.push(handle);
        }
        const results = await Promise.all(handles.map(handle => handle.completion));
        await vi.waitFor(() => expect(manager.Queue.Value).toEqual([manual]));
        expect(results.every(result => result.outcome === 'succeeded')).toBe(true);
        expect(await handles[0].completion).toBe(results[0]);
        expect(handles[0].status.Value).toBe(Status.Completed);
    });
    it('Should permit new requests after failed and completed attempts', async () => {
        const f = fixture();
        const manager = f.manager();
        f.item.Fetch.mockRejectedValueOnce(new Error('Temporary failure'));
        const first = await manager.EnqueueTask(f.container);
        expect((await first.completion).outcome).toBe('failed');
        const second = await manager.EnqueueTask(f.container);
        expect((await second.completion).outcome).toBe('succeeded');
        const third = await manager.EnqueueTask(f.container);
        expect((await third.completion).outcome).toBe('succeeded');
        expect(new Set([first.attemptId, second.attemptId, third.attemptId]).size).toBe(3);
    });

    it('Should cancel a queued archive attempt without cancelling the running manual attempt', async () => {
        const f = fixture();
        let release: (data: Blob) => void;
        f.item.Fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const manager = f.manager();
        const manual = await manager.EnqueueTask(f.container, { directory: directory('manual'), owner: 'manual' });
        await vi.waitFor(() => expect(f.item.Fetch).toHaveBeenCalledTimes(1));
        const archive = await manager.EnqueueTask(f.container, { directory: directory('archive'), owner: 'archive:session' });
        archive.cancel();
        expect((await archive.completion).outcome).toBe('cancelled');
        release(f.data);
        expect((await manual.completion).outcome).toBe('succeeded');
        expect(f.item.Fetch).toHaveBeenCalledTimes(1);
    });

    it('Should snapshot independent destinations and formats without mutating caller options', async () => {
        const f = fixture();
        const manager = f.manager();
        const options = { directory: directory('manual'), format: 'image/*', owner: 'manual' };
        const first = await manager.EnqueueTask(f.container, options);
        options.format = 'changed-after-enqueue';
        const second = await manager.EnqueueTask(f.container, { directory: directory('archive'), format: 'application/x-cbz', owner: 'archive' });
        await Promise.all([first.completion, second.completion]);
        expect(f.media.Store.mock.calls.map(call => call[1].format)).toEqual(['image/*', 'application/x-cbz']);
        expect(f.media.Store.mock.calls.map(call => call[1].directory.name)).toEqual(['manual', 'archive']);
    });

    it('Should preserve the void legacy Enqueue API alongside handle requests', async () => {
        const f = fixture();
        const manager = f.manager();
        expect(await manager.Enqueue(f.container)).toBeUndefined();
        expect(manager.Queue.Value).toHaveLength(1);
        expect((await manager.Queue.Value[0].Handle.completion).outcome).toBe('succeeded');
    });
});

describe('Output lock', () => {
    it('Should serialize aliased destination handles and release ownership after errors', async () => {
        const target = directory('same-directory');
        let release: () => void;
        const entered = vi.fn();
        const first = WithOutputLock(target, undefined, async () => {
            entered('first');
            await new Promise<void>(resolve => { release = resolve; });
            throw new Error('First writer failed');
        });
        const failed = expect(first).rejects.toThrow('First writer failed');
        await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
        const second = WithOutputLock(directory('same-directory'), undefined, async () => entered('second'));
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(entered).toHaveBeenCalledTimes(1);
        release();
        await failed;
        await second;
        expect(entered.mock.calls).toEqual([['first'], ['second']]);
    });

    it('Should allow independent directories and cancel a waiting writer without releasing the active lock', async () => {
        let release: () => void;
        const first = WithOutputLock(directory('a'), undefined, () => new Promise<void>(resolve => { release = resolve; }));
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const action = vi.fn();
        const cancellation = new AbortController();
        const waiting = WithOutputLock(directory('a'), cancellation.signal, action);
        const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
        cancellation.abort();
        await rejected;
        expect(action).not.toHaveBeenCalled();
        await WithOutputLock(directory('b'), undefined, async () => action());
        expect(action).toHaveBeenCalledTimes(1);
        release();
        await first;
    });
});
