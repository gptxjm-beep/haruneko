import { ArchiveChannel, type ArchiveCommand, type ArchiveReply, type ArchiveFileReceipt } from '../../../../app/electron/src/archive/ArchiveProtocol';
import { ArchivePersistenceError, type NativeArchiveTarget } from '../DownloadContract';

export class ArchiveClient {
    constructor(private readonly invoke: (command: ArchiveCommand) => Promise<ArchiveReply> = command => {
        if (!globalThis.ipcRenderer) throw new Error('Electron archive service is unavailable');
        return globalThis.ipcRenderer.invoke(ArchiveChannel, command);
    }) {}

    public async Request<T>(command: ArchiveCommand): Promise<T> {
        const reply = await this.invoke(command);
        if (reply.ok === false) {
            if (reply.error.kind === 'repository') throw new ArchivePersistenceError(reply.error.message);
            throw new Error(reply.error.message);
        }
        return reply.value as T;
    }

    public Target(attemptId: string, session: { root_id: string; settings: { format: string; useWebsiteSubDirectory: boolean } }): NativeArchiveTarget {
        return {
            identity: attemptId, rootId: session.root_id, format: session.settings.format, useWebsiteSubDirectory: session.settings.useWebsiteSubDirectory,
            checkpoint: async (stage, receivedPages, validatedPages) => {
                try { await this.Request({ operation: 'checkpoint', attemptId, stage, receivedPages, validatedPages }); }
                catch(cause) { throw new ArchivePersistenceError('Archive progress could not be committed', { cause }); }
            },
            beginExport: async (expectedFiles, format) => {
                if (format !== session.settings.format) throw new Error('Archive export format differs from the session');
                try { await this.Request({ operation: 'checkpoint', attemptId, stage: 'export', expectedFiles }); }
                catch(cause) { throw new ArchivePersistenceError('Archive export plan could not be committed', { cause }); }
            },
            write: async (path, data, signal) => {
                signal.throwIfAborted();
                const writeId = await this.Request<string>({ operation: 'begin-file', attemptId, path, size: data.size });
                try {
                    for (let offset = 0; offset < data.size; offset += 64 * 1024) {
                        signal.throwIfAborted();
                        const bytes = new Uint8Array(await data.slice(offset, offset + 64 * 1024).arrayBuffer());
                        await this.Request({ operation: 'write-chunk', writeId, bytes });
                    }
                    signal.throwIfAborted();
                    const receipt = await this.Request<ArchiveFileReceipt>({ operation: 'finish-file', writeId });
                    return { path: receipt.path, size: receipt.size, rootId: receipt.rootId, sha256: receipt.sha256, fileId: receipt.fileId };
                } catch(error) {
                    try { await this.Request({ operation: 'abort-file', writeId }); } catch { /* Durable intent remains available for recovery. */ }
                    throw error;
                }
            },
        };
    }
}
