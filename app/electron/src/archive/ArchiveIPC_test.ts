import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { app, ipcMain } from 'electron';
import { ArchiveIPC, AssertArchiveSender } from './ArchiveIPC';

vi.mock('electron', () => ({ app: { once: vi.fn(), getPath: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

function fixture() {
    const frame = { url: 'https://app.hakuneko.download/' };
    const contents = { mainFrame: frame, on: vi.fn(), off: vi.fn() };
    return { frame, contents, window: { webContents: contents } as unknown as BrowserWindow,
        event: { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent };
}

describe('Archive IPC authority boundary', () => {
    it('Should accept only the configured main window and exact origin', () => {
        const f = fixture();
        expect(() => AssertArchiveSender(f.event, f.window, 'https://app.hakuneko.download')).not.toThrow();
    });

    it('Should reject another window even on the same origin', () => {
        const f = fixture();
        expect(() => AssertArchiveSender({ ...f.event, sender: {} } as IpcMainInvokeEvent, f.window, 'https://app.hakuneko.download')).toThrow('not authorized');
    });

    it('Should reject subframes and detached frames', () => {
        const f = fixture();
        expect(() => AssertArchiveSender({ ...f.event, senderFrame: { ...f.frame } } as IpcMainInvokeEvent, f.window, 'https://app.hakuneko.download')).toThrow();
        expect(() => AssertArchiveSender({ ...f.event, senderFrame: null } as IpcMainInvokeEvent, f.window, 'https://app.hakuneko.download')).toThrow();
    });

    it.each(['https://other.invalid/', 'https://app.hakuneko.download:444/', 'http://app.hakuneko.download/'])('Should reject a navigation to %s', url => {
        const f = fixture();
        f.frame.url = url;
        expect(() => AssertArchiveSender(f.event, f.window, 'https://app.hakuneko.download')).toThrow();
    });

    it('Should reject opaque origins even if configured as null', () => {
        const f = fixture();
        f.frame.url = 'about:blank';
        expect(() => AssertArchiveSender(f.event, f.window, 'null')).toThrow();
    });

    it('Should validate sender and command shape before opening any database', async () => {
        const f = fixture();
        const service = new ArchiveIPC(f.window, 'https://app.hakuneko.download');
        const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
        expect(() => handler({ ...f.event, sender: {} } as IpcMainInvokeEvent, { operation: 'list-sessions' })).toThrow();
        expect(() => handler(f.event, [])).toThrow('Invalid');
        expect(() => handler(f.event, {})).toThrow('Invalid');
        expect(app.getPath).not.toHaveBeenCalled();
        await service.Close();
        const removed = vi.mocked(ipcMain.removeHandler).mock.calls.length;
        await service.Close();
        expect(vi.mocked(ipcMain.removeHandler).mock.calls.length).toBe(removed);
    });

    it('Should reject old renderer requests during navigation before opening the database', async () => {
        const f = fixture();
        const service = new ArchiveIPC(f.window, 'https://app.hakuneko.download');
        const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
        const on = f.contents.on;
        const navigate = on.mock.calls.find(call => call[0] === 'did-start-navigation')![1] as (details: unknown) => void;
        navigate({ isMainFrame: true, isSameDocument: false });
        expect(() => handler(f.event, { operation: 'ui-sessions' })).toThrow('renderer is changing');
        await service.Close();
    });

    it('Should discard queued requests accepted before renderer replacement', async () => {
        const f = fixture();
        const service = new ArchiveIPC(f.window, 'https://app.hakuneko.download');
        const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
        const pending = handler(f.event, { operation: 'ui-sessions' });
        const on = f.contents.on;
        const navigate = on.mock.calls.find(call => call[0] === 'did-start-navigation')![1] as (details: unknown) => void;
        navigate({ isMainFrame: true, isSameDocument: false });
        await expect(pending).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('replaced renderer') } });
        await service.Close();
    });
});
