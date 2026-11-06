import type { ExportContext } from '../DownloadContract';

type BlobStream = { on: (event: string, action: (value?: any) => void) => unknown; pause: () => unknown; resume: () => unknown; destroy?: (error?: Error) => unknown };
const quantum = 8 * 1024 * 1024;

/** Pause producers before accepting more output; reserve the next bounded quantum before creating a spillable Blob. */
export function CollectArchiveBlob(stream: BlobStream, context: ExportContext, type: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        let reserved = 0;
        let done = false;
        let pending = Promise.resolve();
        const abort = () => fail(context.signal.reason);
        const fail = (error: unknown) => {
            if (done) return;
            done = true; chunks.length = 0;
            context.signal.removeEventListener('abort', abort);
            stream.pause(); stream.destroy?.(error instanceof Error ? error : undefined);
            reject(error);
        };
        stream.on('error', fail);
        stream.on('data', (bytes: Uint8Array) => {
            stream.pause();
            pending = pending.then(async () => {
                if (done) return;
                context.signal.throwIfAborted();
                size += bytes.byteLength;
                if (size > reserved) {
                    reserved = Math.ceil(size / quantum) * quantum;
                    await context.prepare(reserved * 2);
                }
                if (done) return;
                chunks.push(new Uint8Array(bytes));
                if (!done) stream.resume();
            });
            pending.catch(fail);
        });
        stream.on('end', () => {
            pending.then(() => {
                if (done) return;
                context.signal.throwIfAborted();
                const data = new Blob(chunks, { type });
                done = true; chunks.length = 0;
                context.signal.removeEventListener('abort', abort);
                resolve(data);
            }).catch(fail);
        });
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort(); else stream.resume();
    });
}
