// Shared by all DownloadManager instances. A directory lock is deliberately conservative:
// different chapter files in the same directory serialize rather than risk alias collisions.
const writers: { directory: FileSystemDirectoryHandle; done: Promise<void> }[] = [];
let admission: Promise<void> = Promise.resolve();

export async function WithOutputLock<T>(directory: FileSystemDirectoryHandle, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    while (true) {
        signal?.throwIfAborted();
        const previous = admission;
        let releaseAdmission: () => void;
        admission = new Promise(resolve => { releaseAdmission = resolve; });
        await previous;
        let conflict: Promise<void>;
        let release: () => void;
        let entry: typeof writers[number];
        try {
            for (const writer of writers) {
                if (await directory.isSameEntry(writer.directory)
                    || await directory.resolve(writer.directory) !== null
                    || await writer.directory.resolve(directory) !== null) {
                    conflict = writer.done;
                    break;
                }
            }
            if (!conflict) {
                entry = { directory, done: new Promise(resolve => { release = resolve; }) };
                writers.push(entry);
            }
        } finally {
            releaseAdmission();
        }
        if (conflict) {
            // Wait for the owned writer; cancellation never releases its lock early.
            await new Promise<void>(resolve => {
                const abort = () => { signal?.removeEventListener('abort', abort); resolve(); };
                signal?.addEventListener('abort', abort, { once: true });
                conflict.then(abort);
                if (signal?.aborted) abort();
            });
            continue;
        }
        try {
            signal?.throwIfAborted();
            return await action();
        } finally {
            writers.splice(writers.indexOf(entry), 1);
            release();
        }
    }
}
