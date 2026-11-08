import { describe, expect, it, vi } from 'vitest';
import { Channels } from '../../../../../app/electron/src/ipc/InterProcessCommunicationChannels';
const ipc = vi.hoisted(() => ({ Invoke: vi.fn(), On: vi.fn() }));
vi.mock('./InterProcessCommunication', () => ({ GetIPC: () => ipc }));
import RemoteBrowserWindow from './RemoteBrowserWindow';
describe('Native remote-window allocation ownership', () => {
    it('Should wait for window allocation before closing, so cancellation cannot leave an orphan window', async () => {
        let allocate: (id: number) => void;
        const gate = new Promise<number>(resolve => { allocate = resolve; }), closed: number[] = [];
        ipc.Invoke.mockImplementation(async (channel, id) => { if (channel === Channels.RemoteBrowserWindowController.OpenWindow) return gate; if (channel === Channels.RemoteBrowserWindowController.CloseWindow) closed.push(id); });
        const window = new RemoteBrowserWindow();
        const opening = window.Open(new Request('https://fixture.invalid'));
        const closing = window.Close();
        await Promise.resolve(); expect(closed).toEqual([]);
        allocate(42); await opening; await closing;
        expect(closed).toEqual([42]);
    });
});
