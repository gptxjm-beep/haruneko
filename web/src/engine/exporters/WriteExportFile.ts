import type { ExportContext } from '../DownloadContract';

/** Close successfully before reporting a written file; never delete an existing output. */
export async function WriteExportFile(directory: FileSystemDirectoryHandle, name: string, data: Blob, context?: ExportContext, path = name): Promise<void> {
    context?.signal.throwIfAborted();
    context?.writing(path);
    const file = await directory.getFileHandle(name, { create: true });
    context?.signal.throwIfAborted();
    const stream = await file.createWritable();
    const abort = () => { stream.abort(context.signal.reason).catch(() => { /* Keep the primary write/cancellation error. */ }); };
    context?.signal.addEventListener('abort', abort, { once: true });
    try {
        context?.signal.throwIfAborted();
        await stream.write(data);
        context?.signal.throwIfAborted();
        await stream.close();
        context?.written({ path, size: data.size, handle: file });
    } catch(error) {
        try { await stream.abort(error); } catch { /* The stream may already be closed or aborted. */ }
        throw error;
    } finally {
        context?.signal.removeEventListener('abort', abort);
    }
}
