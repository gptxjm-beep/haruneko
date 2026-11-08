import { vi, describe, it, expect } from 'vitest';
import type { IPC } from './InterProcessCommunication';
import { Channels } from './InterProcessCommunicationChannels';
vi.mock('electron', () => ({ BrowserWindow: { fromId: vi.fn(() => undefined) } }));
import { RemoteBrowserWindowController } from './RemoteBrowserWindow';

class TestFixture {

    public readonly mockIPC = {
        Handle: vi.fn(),
    } as unknown as IPC;

    public CreatTestee(): RemoteBrowserWindowController {
        return new RemoteBrowserWindowController(this.mockIPC);
    }
}

describe('RemoteBrowserWindowController', () => {

    it('Should close an already user-closed verification window idempotently so another deferred site can be opened', async () => {
        const fixture = new TestFixture(); fixture.CreatTestee();
        const callback = vi.mocked(fixture.mockIPC.Handle).mock.calls.find(call => String(call[0]) === String(Channels.RemoteBrowserWindowController.CloseWindow))![1] as (id: number) => Promise<void>;
        await expect(callback(42)).resolves.toBeUndefined();
        await expect(callback(42)).resolves.toBeUndefined();
    });
    describe('Constructor', () => {

        it('Should subscribe to IPC events', () => {
            const fixture = new TestFixture();
            const testee = fixture.CreatTestee();
            expect(testee).toBeDefined();
            expect(fixture.mockIPC.Handle).toHaveBeenCalledTimes(6);
            expect(fixture.mockIPC.Handle).toHaveBeenCalledWith(Channels.RemoteBrowserWindowController.OpenWindow, expect.anything());
            expect(fixture.mockIPC.Handle).toHaveBeenCalledWith(Channels.RemoteBrowserWindowController.CloseWindow, expect.anything());
            expect(fixture.mockIPC.Handle).toHaveBeenCalledWith(Channels.RemoteBrowserWindowController.SetVisibility, expect.anything());
            expect(fixture.mockIPC.Handle).toHaveBeenCalledWith(Channels.RemoteBrowserWindowController.ExecuteScript, expect.anything());
            expect(fixture.mockIPC.Handle).toHaveBeenCalledWith(Channels.RemoteBrowserWindowController.SendDebugCommand, expect.anything());
            expect(fixture.mockIPC.Handle).toHaveBeenCalledWith(Channels.RemoteBrowserWindowController.LoadURL, expect.anything());
        });
    });
});