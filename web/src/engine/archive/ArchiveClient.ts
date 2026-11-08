import { ArchiveChannel, type ArchiveCommand, type ArchiveReply, type ArchiveFileReceipt } from '../../../../app/electron/src/archive/ArchiveProtocol';
import { ArchivePersistenceError, ArchiveCapacityError, type NativeArchiveTarget } from '../DownloadContract';
import { IPCData } from './IPCData';

export class ArchiveClient {
    constructor(private readonly invoke: (command: ArchiveCommand) => Promise<ArchiveReply> = command => {
        if (!globalThis.ipcRenderer) throw new Error('Electron archive service is unavailable');
        return globalThis.ipcRenderer.invoke(ArchiveChannel, command);
    }) {}

    private async Quota(): Promise<{ usage: number; quota: number }> {
        let quota: StorageEstimate;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            quota = await Promise.race([navigator.storage.estimate(), new Promise<StorageEstimate>((_resolve, reject) => {
                timer = setTimeout(() => reject(new ArchiveCapacityError('Browser quota measurement timed out', { code: 'unmeasurable', location: 'indexeddb-quota', systemCode: 'MEASUREMENT_TIMEOUT' })), 5000);
            })]);
        } catch(error) {
            if (error instanceof ArchiveCapacityError) throw error;
            throw new ArchiveCapacityError('Browser storage quota cannot be measured', { code: 'unmeasurable', location: 'indexeddb-quota' });
        } finally { clearTimeout(timer); }
        if (!quota || !Number.isSafeInteger(quota.usage) || !Number.isSafeInteger(quota.quota)) throw new ArchiveCapacityError('Browser storage quota is unknown', { code: 'unmeasurable', location: 'indexeddb-quota' });
        return { usage: quota.usage, quota: quota.quota };
    }

    public async Request<T>(command: ArchiveCommand): Promise<T> {
        const reply = await this.invoke(IPCData(command));
        if (reply.ok === false) {
            if (reply.error.kind === 'storage') throw new ArchiveCapacityError(reply.error.message, reply.error.storage);
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
                catch(cause) { if (cause instanceof ArchiveCapacityError) throw cause; throw new ArchivePersistenceError('Archive progress could not be committed', { cause }); }
            },
            beginExport: async (expectedFiles, format) => {
                if (format !== session.settings.format) throw new Error('Archive export format differs from the session');
                try { await this.Request({ operation: 'checkpoint', attemptId, stage: 'export', expectedFiles }); }
                catch(cause) { if (cause instanceof ArchiveCapacityError) throw cause; throw new ArchivePersistenceError('Archive export plan could not be committed', { cause }); }
            },
            beforeTemporaryWrite: async bytes => {
                await this.Request({ operation: 'storage-image', attemptId, bytes, quota: await this.Quota() });
            },
            beforeFetch: async () => { await this.Request({ operation: 'storage-image-preflight', attemptId, quota: await this.Quota() }); },
            prepare: bytes => this.Request({ operation: 'storage-prepare', attemptId, bytes }),
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
