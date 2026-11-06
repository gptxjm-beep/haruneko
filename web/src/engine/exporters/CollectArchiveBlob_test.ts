import { describe, expect, it, vi } from 'vitest';
import { CollectArchiveBlob } from './CollectArchiveBlob';
import type { ExportContext } from '../DownloadContract';
import { ArchiveCapacityError } from '../DownloadContract';

function fixture(prepare: (bytes: number) => Promise<void>) {
    const handlers = new Map<string, (value?: unknown) => void>();
    const stream = { on: (event: string, action: (value?: unknown) => void) => handlers.set(event, action), pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() };
    const cancellation = new AbortController();
    const context = { signal: cancellation.signal, prepare } as ExportContext;
    const completion = CollectArchiveBlob(stream, context, 'application/x-cbz');
    return { stream, cancellation, completion, emit: (event: string, value?: unknown) => handlers.get(event)?.(value) };
}

describe('Archive output preparation capacity', () => {
    it('Should expand its reservation before collecting a growing output', async () => {
        const prepare = vi.fn().mockResolvedValue(undefined);
        const f = fixture(prepare);
        f.emit('data', new Uint8Array(9 * 1024 ** 2));
        f.emit('end');
        expect((await f.completion).size).toBe(9 * 1024 ** 2);
        expect(prepare).toHaveBeenCalledWith(32 * 1024 ** 2);
    });

    it('Should reject a capacity failure before creating the final Blob', async () => {
        const failure = new ArchiveCapacityError('No preparation capacity', { code: 'low-space', location: 'preparation' });
        const f = fixture(async () => { throw failure; });
        f.emit('data', new Uint8Array([1, 2, 3]));
        f.emit('end');
        await expect(f.completion).rejects.toBe(failure);
        expect(f.stream.destroy).toHaveBeenCalledWith(failure);
    });

    it('Should cancel while an asynchronous reservation is pending', async () => {
        let release!: () => void;
        const prepare = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
        const f = fixture(prepare);
        f.emit('data', new Uint8Array([1]));
        await Promise.resolve();
        f.cancellation.abort(new Error('Cancelled'));
        await expect(f.completion).rejects.toThrow('Cancelled');
        const resumed = f.stream.resume.mock.calls.length;
        release();
        await Promise.resolve(); await Promise.resolve();
        expect(f.stream.resume.mock.calls.length).toBe(resumed);
    });
});
