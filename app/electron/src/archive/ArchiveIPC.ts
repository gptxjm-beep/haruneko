import path from 'node:path';
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { ArchiveRepository } from './ArchiveRepository';
import { ArchiveFiles } from './ArchiveFiles';
import { ArchiveChannel, type ArchiveCommand } from './ArchiveProtocol';
import { SafeMessage } from './ArchivePaths';

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

    constructor(private readonly window: BrowserWindow, private readonly origin: string) {
        ipcMain.handle(ArchiveChannel, (event, command) => {
            AssertArchiveSender(event, this.window, this.origin);
            if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.operation !== 'string') throw new Error('Invalid archive command');
            if (this.pending >= 128) throw new Error('Archive service is busy');
            this.pending++;
            const operation = this.serial.then(() => this.Execute(command));
            this.serial = operation.catch(() => {});
            return operation.then(value => ({ ok: true, value })).catch(error => {
                return { ok: false, error: { kind: String(error.code ?? '').includes('SQLITE') ? 'repository' : error.code ? 'filesystem' : 'validation',
                    message: SafeMessage(error.code ? `Archive operation failed (${error.code})` : error.message) } };
            }).finally(() => { this.pending--; });
        });
        app.once('before-quit', event => {
            event.preventDefault();
            this.Close().finally(() => app.quit());
        });
    }

    public async Close(): Promise<void> {
        ipcMain.removeHandler(ArchiveChannel);
        await this.serial;
        await this.files?.Close();
        this.repository?.Close();
    }

    private async Execute(command: ArchiveCommand): Promise<unknown> {
        if (!this.repository) {
            this.repository = new ArchiveRepository(path.join(app.getPath('userData'), 'archive', 'state.sqlite'));
            this.files = new ArchiveFiles(this.repository);
        }
        switch (command.operation) {
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
