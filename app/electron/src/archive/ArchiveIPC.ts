import type { CartCommand } from './SelectionCartContract';
import path from 'node:path';
import { app, dialog, ipcMain, shell, nativeImage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { mkdir, open, stat, readFile } from 'node:fs/promises';
import { CatalogLogs } from './CatalogLogs';
import { MangaInfoEditor } from './MangaInfoEditor';
import { MangaDetailsFiles } from './MangaDetailsFiles';
import { ArchiveRepository } from './ArchiveRepository';
import { ArchiveFiles } from './ArchiveFiles';
import { ArchiveChannel, type ArchiveCommand } from './ArchiveProtocol';
import { SafeMessage } from './ArchivePaths';
import type { ArchiveCoordinatorCommand } from './ArchiveCoordinatorProtocol';
import type { SelectiveQueueCommand } from './SelectiveQueueContract';
import { ArchiveStorageSafety, DefaultArchiveStoragePolicy, type ArchiveStoragePolicy, type ArchiveVolumeProbe } from './ArchiveStorageSafety';
import { ArchiveStorageController } from './ArchiveStorageController';
import { StorageFailure, ArchiveStorageError } from './ArchiveStorageContract';

export function AssertArchiveSender(event: IpcMainInvokeEvent, window: BrowserWindow, expectedOrigin: string): void {
    if (event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame
        || new URL(event.senderFrame.url).origin !== expectedOrigin
        || !/^https:\/\//.test(expectedOrigin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(expectedOrigin)) throw new Error('Archive request origin is not authorized');
}

export class ArchiveIPC {
    private repository!: ArchiveRepository;
    private files!: ArchiveFiles;
    private serial: Promise<unknown> = Promise.resolve();
    private pending = 0;
    private storage!: ArchiveStorageController;
    private readonly safety: ArchiveStorageSafety;
    private readonly bootstrapSafety: ArchiveStorageSafety;
    private rendererRecoveryError?: Error;
    private closing?: Promise<void>;
    private navigating = false;
    private rendererEpoch = 0;
    private readonly navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) { this.navigating = true; this.rendererEpoch++; this.InterruptRenderer(); }
    };
    private readonly rendererGone = () => { this.navigating = true; this.rendererEpoch++; this.InterruptRenderer(); };
    private readonly rendererLoaded = () => { this.navigating = false; };

    private InterruptRenderer(): void {
        if (!this.repository) return;
        const recovery = this.serial.then(async () => {
            try {
                await this.files.Close();
                await this.storage.ReleaseAll();
                this.repository.RecoverInterrupted();
            } catch { this.rendererRecoveryError = new Error('Archive interruption requires an application restart before further operations'); }
        });
        this.serial = recovery;
    }

    constructor(private readonly window: BrowserWindow, private readonly origin: string, options: { storagePolicy?: ArchiveStoragePolicy; storageProbe?: ArchiveVolumeProbe } = {}) {
        this.safety = new ArchiveStorageSafety(options.storagePolicy ?? DefaultArchiveStoragePolicy, options.storageProbe);
        this.bootstrapSafety = new ArchiveStorageSafety({ reserveBytes: 0n, metadataHeadroomBytes: (options.storagePolicy ?? DefaultArchiveStoragePolicy).metadataHeadroomBytes }, options.storageProbe);
        this.window.webContents.on?.('did-start-navigation', this.navigation);
        this.window.webContents.on?.('render-process-gone', this.rendererGone);
        this.window.webContents.on?.('did-finish-load', this.rendererLoaded);
        ipcMain.handle(ArchiveChannel, (event, command) => {
            AssertArchiveSender(event, this.window, this.origin);
            if (this.navigating || this.closing) throw new Error('Archive renderer is changing or the service is closing');
            if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.operation !== 'string') throw new Error('Invalid archive command');
            if (this.pending >= 128) throw new Error('Archive service is busy');
            this.pending++;
            const epoch = this.rendererEpoch;
            const operation = this.serial.then(() => {
                if (epoch !== this.rendererEpoch) throw new Error('Archive request belonged to a replaced renderer');
                return this.Execute(command);
            });
            this.serial = operation.catch(() => {});
            return operation.then(value => ({ ok: true, value })).catch(error => {
                const databaseError = String(error.code ?? '').includes('SQLITE') || /database or disk is full/i.test(error.message ?? '');
                const storage = StorageFailure(error, databaseError ? 'database' : 'archive-service');
                if (storage) return { ok: false, error: { kind: 'storage', message: storage.message, storage: storage.Fault } };
                return { ok: false, error: { kind: String(error.code ?? '').includes('SQLITE') ? 'repository' : error.code ? 'filesystem' : 'validation',
                    message: SafeMessage(error.code ? `Archive operation failed (${error.code})` : error.message) } };
            }).finally(() => { this.pending--; });
        });
        app.once('before-quit', event => {
            event.preventDefault();
            void this.Close().catch(() => console.error('Archive shutdown could not finish; recovery is required on the next start')).finally(() => app.quit());
        });
    }

    public Close(): Promise<void> { return this.closing ??= this.CloseInternal(); }

    private async CloseInternal(): Promise<void> {
        if (!this.window.isDestroyed?.() && !this.window.webContents.isDestroyed?.()) {
            this.window.webContents.off?.('did-start-navigation', this.navigation);
            this.window.webContents.off?.('render-process-gone', this.rendererGone);
            this.window.webContents.off?.('did-finish-load', this.rendererLoaded);
        }
        ipcMain.removeHandler(ArchiveChannel);
        await this.serial;
        try { await this.files?.Close(); }
        finally { this.repository?.Close(); }
    }

    private async Execute(command: ArchiveCommand): Promise<unknown> {
        if (command.operation === 'catalog-log' || command.operation === 'catalog-open-logs') {
            const logs = new CatalogLogs(path.join(app.getPath('userData'), 'logs', 'arabic-manga'));
            if (command.operation === 'catalog-log') return logs.Write(command.runId, command.event).catch(() => {});
            await mkdir(logs.Directory, { recursive: true });
            return shell.openPath(logs.Directory);
        }
        if (this.rendererRecoveryError) throw this.rendererRecoveryError;
        if (!this.repository) {
            await this.bootstrapSafety.Check([{ slot: 'bootstrap', path: app.getPath('userData'), location: 'database', bytes: 0n }]);
            const browser = this.window.webContents.session.getStoragePath();
            if (!browser) throw new ArchiveStorageError({ code: 'unmeasurable', location: 'browser-profile' });
            this.repository = new ArchiveRepository(path.join(app.getPath('userData'), 'archive', 'state.sqlite'));
            this.safety.ConfigureReserve(BigInt(this.repository.UI.Preferences().reserveGiB) * 1024n ** 3n);
            this.storage = new ArchiveStorageController(this.repository, { profile: app.getPath('userData'), browser,
                staging: this.repository.StagingDirectory, scratch: app.getPath('temp') }, this.safety);
            this.files = new ArchiveFiles(this.repository, undefined, this.storage);
        }
        // Control receipts and cleanup remain writable from the metadata emergency margin.
        const metadata = ['archive-catalog-page', 'archive-manifest-begin', 'archive-manifest-batch', 'archive-manifest-end', 'archive-manga-begin', 'archive-chapter-begin', 'register-chapter', 'begin-attempt', 'checkpoint'];
        if (metadata.includes(command.operation)) {
            const sessionId = 'sessionId' in command ? command.sessionId : 'attemptId' in command ? String(this.repository.Attempt(command.attemptId).session_id) : undefined;
            if (sessionId) {
                let bytes = BigInt(Buffer.byteLength(JSON.stringify(command))) * 8n + 4n * 1024n ** 2n;
                if (command.operation === 'archive-manifest-end') bytes += this.repository.Work.ManifestStorageEstimate(command.sessionId, command.mangaId);
                await this.storage.CheckSession(sessionId, bytes);
            }
        }
        if (command.operation.startsWith('archive-')) return this.repository.Work.Execute(command as ArchiveCoordinatorCommand);
        if (command.operation === 'queue-info-cover') {
            const picked = await dialog.showOpenDialog(this.window, { properties: ['openFile'], filters: [{ name: 'Cover image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
            if (picked.canceled || !picked.filePaths[0]) return null;
            if ((await stat(picked.filePaths[0])).size > 8 * 1024 ** 2) throw new Error('Cover exceeds 8 MiB');
            const bytes = await readFile(picked.filePaths[0]), image = nativeImage.createFromBuffer(bytes), size = image.getSize();
            if (image.isEmpty() || size.width * size.height > 32000000) throw new Error('Cover is invalid or too large');
            return new Uint8Array(image.toPNG());
        }
        if (['queue-open-folder', 'queue-info-read', 'queue-info-save'].includes(command.operation)) {
            const editor = new MangaInfoEditor(this.repository, new MangaDetailsFiles(this.repository, this.storage), this.storage, bytes => { const image = nativeImage.createFromBuffer(Buffer.from(bytes)), size = image.getSize(); return !image.isEmpty() && size.width * size.height <= 32000000; });
            if (command.operation === 'queue-open-folder') {
                const folder = await editor.Folder(command.seq);
                try { const error = await shell.openPath(folder); if (error) throw new Error('System file browser could not open the manga folder'); }
                catch { throw new Error('System file browser could not open the manga folder'); }
                return;
            }
            if (command.operation === 'queue-info-read') return editor.Read(command.seq);
            if (command.operation === 'queue-info-save') {
                if (command.cover && (!(command.cover instanceof Uint8Array) || command.cover.length > 8 * 1024 ** 2 || nativeImage.createFromBuffer(Buffer.from(command.cover)).isEmpty())) throw new Error('Invalid cover');
                return editor.Save(command.seq, command.draft, command.confirmed, command.cover);
            }
        }
        if (command.operation === 'queue-details-save') {
            if (command.cover) {
                if (!(command.cover instanceof Uint8Array) || command.cover.length > 8 * 1024 ** 2) throw new Error('Invalid cover payload');
                if (nativeImage.createFromBuffer(Buffer.from(command.cover)).isEmpty()) { command = { ...command, cover: undefined, partial: true }; }
            }
            return new MangaDetailsFiles(this.repository, this.storage).Save(command.seq, command);
        }
        if (command.operation === 'queue-details-inspect') return new MangaDetailsFiles(this.repository, this.storage).Inspect(command.seq);
        if (command.operation === 'queue-cover') return new MangaDetailsFiles(this.repository, this.storage).Cover(command.seq).catch(() => null);
        if (command.operation === 'queue-export-report') {
            const report = this.repository.Queue.Report(command.seq);
            const selection = await dialog.showSaveDialog(this.window, { defaultPath: `download-report-${command.seq}-${Date.now()}.json`, filters: [{ name: 'JSON report', extensions: ['json'] }] });
            if (selection.canceled || !selection.filePath) return false;
            const file = await open(selection.filePath, 'wx', 0o600);
            try { await file.writeFile(JSON.stringify(report, null, 2)); await file.sync(); } finally { await file.close(); }
            return true;
        }
        if (command.operation === 'queue-audit') {
            const results = [];
            for (const row of this.repository.Queue.AuditRows(command.seq)) {
                try { const result = await this.files.Recover(String(row.session_id), String(row.chapter_key)); results.push({ id: row.id, sessionId: row.session_id, key: row.chapter_key, state: result.localState }); }
                catch { results.push({ id: row.id, sessionId: row.session_id, key: row.chapter_key, state: 'uncertain' }); }
            }
            this.repository.Queue.AuditResult(command.seq, results);
            return results.map(row => ({ id: row.id, localState: row.state }));
        }
        if (command.operation.startsWith('cart-')) return this.repository.Cart.Execute(command as CartCommand);
        if (command.operation.startsWith('queue-')) return this.repository.Queue.Execute(command as SelectiveQueueCommand);
        switch (command.operation) {
            case 'ui-preferences': return { preferences: this.repository.UI.Preferences(), rootLabel: this.repository.UI.RootLabel(this.repository.UI.Preferences().rootId) };
            case 'ui-save-preferences': {
                const validated = this.repository.UI.Validate(command.preferences);
                const previous = this.repository.UI.Preferences();
                if (validated.reserveGiB !== previous.reserveGiB) this.safety.ConfigureReserve(BigInt(validated.reserveGiB) * 1024n ** 3n);
                try { return this.repository.UI.Save(validated); }
                catch(error) { if (validated.reserveGiB !== previous.reserveGiB) this.safety.ConfigureReserve(BigInt(previous.reserveGiB) * 1024n ** 3n); throw error; }
            }
            case 'ui-create-session': return this.repository.UI.Create(command.siteId, command.siteName, command.preferences, command.confirmed);
            case 'ui-sessions': return this.repository.UI.Sessions(command.before);
            case 'ui-progress': return this.repository.UI.Progress(command.sessionId);
            case 'storage-check': return this.storage.CheckSession(command.sessionId);
            case 'storage-image': return this.storage.Image(command.attemptId, command.bytes, command.quota);
            case 'storage-image-preflight': return this.storage.Image(command.attemptId, 64 * 1024 ** 2, command.quota, true);
            case 'storage-prepare': return this.storage.Prepare(command.attemptId, command.bytes);
            case 'storage-release': return this.storage.ReleaseAttempt(command.attemptId);
            case 'choose-root': {
                const selection = await dialog.showOpenDialog(this.window, { properties: ['openDirectory', 'createDirectory'] });
                return selection.canceled || !selection.filePaths[0] ? null : this.repository.GrantRoot(selection.filePaths[0]);
            }
            case 'create-session': return this.repository.CreateSession(command.rootId, command.siteId, command.siteName, command.settings);
            case 'list-sessions': return this.repository.ListSessions();
            case 'session': return this.repository.Session(command.sessionId);
            case 'register-chapter': return this.repository.RegisterChapter(command.sessionId, command.chapter);
            case 'begin-attempt': return this.repository.BeginAttempt(command.sessionId, command.chapterKey);
            case 'checkpoint': return this.repository.Checkpoint(command.attemptId, command.stage, command.receivedPages, command.validatedPages, command.expectedFiles);
            case 'begin-file': return this.files.Begin(command.attemptId, command.path, command.size);
            case 'write-chunk': return this.files.Chunk(command.writeId, command.bytes);
            case 'finish-file': return this.files.Finish(command.writeId);
            case 'abort-file': return this.files.Abort(command.writeId);
            case 'finish-attempt': return this.repository.FinishAttempt(command.attemptId, command.result);
            case 'recover-chapter': return this.files.Recover(command.sessionId, command.chapterKey, command.fullAudit);
            case 'publish-staged': return this.files.Publish(command.fileId);
            case 'inspect-path': return this.files.Inspect(command.sessionId, command.path, command.hash);
            case 'list-chapters': return this.repository.ListChapters(command.sessionId, command.after);
            case 'set-session-state': return this.repository.SetSessionState(command.sessionId, command.state);
            case 'record-cleanup': return this.repository.RecordCleanup(command.attemptId, command.keys, command.error);
            default: throw new Error('Unsupported archive operation');
        }
    }
}
