import { describe, expect, it, vi } from 'vitest';
import { SelectiveQueueRunner } from './SelectiveQueueRunner';
import { ArchiveClient } from './ArchiveClient';
import { MangaPlugin } from '../providers/MangaPlugin';
import type { ArchiveManager } from './ArchiveManager';
import type { DownloadManager } from '../DownloadManager';
import { DefaultArchivePreferences } from '../../../../app/electron/src/archive/ArchiveUIContract';
import type { QueueManga } from '../../../../app/electron/src/archive/SelectiveQueueContract';
const item = (seq: number): QueueManga => ({ seq, siteId: 'site', mangaId: String(seq), title: 'Title', siteName: 'Site', sessionId: `session-${seq}`, state: 'Queued', reason: '', scope: { mode: 'all' } });
function Fixture(factory: ConstructorParameters<typeof SelectiveQueueRunner>[3], sites: unknown[] = [Object.assign(Object.create(MangaPlugin.prototype), { Identifier: 'site' })], details?: ConstructorParameters<typeof SelectiveQueueRunner>[4]) {
    const pending = [item(1), item(2)], operations: string[] = [];
    let state = 'Paused';
    const client = new ArchiveClient(async command => {
        operations.push(command.operation);
        if (command.operation === 'queue-open') state = 'Running';
        if (command.operation === 'queue-stop') state = command.state;
        if (command.operation === 'queue-next') { const next = pending.shift(); if (!next) state = 'Drained'; return { ok: true, value: next ?? null }; }
        return { ok: true, value: command.operation === 'queue-summary' ? { state } : undefined };
    });
    return { runner: new SelectiveQueueRunner(client, () => sites, {} as DownloadManager, factory, details), operations, pending, state: () => state };
}
describe('Selective queue runner ownership', () => {
    it('Should keep chapter results independent of optional details failures', async () => {
        const download = vi.fn(async () => { throw new Error('Optional cover unavailable'); });
        const f = Fixture(() => ({ Start: async () => {} }) as unknown as ArchiveManager, undefined, { enabled: async () => true, download });
        await f.runner.Start(DefaultArchivePreferences, true);
        expect(download).toHaveBeenCalledTimes(2);
        expect(f.operations.filter(operation => operation === 'queue-result')).toHaveLength(2);
        expect(f.operations).not.toContain('archive-run-state');
        expect(f.state()).toBe('Drained');
    });
    it('Should execute sequentially only after Start, continue after an item failure and retain no completed managers', async () => {
        let active = 0; const seen: number[] = [];
        const f = Fixture((_site, row) => ({ Start: async () => { expect(++active).toBe(1); seen.push(row.seq); await Promise.resolve(); active--; if (row.seq === 1) throw new Error('Fixture failure'); } }) as unknown as ArchiveManager);
        expect(f.operations).toHaveLength(0); await f.runner.Start(DefaultArchivePreferences, true);
        expect(seen).toEqual([1, 2]); expect(f.operations).toContain('archive-run-state'); expect(f.runner.Running).toBe(false);
    });
    it('Should pause its owned manager and refuse another Start while the first invocation is pending', async () => {
        let release: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const pause = vi.fn(async () => release());
        const f = Fixture(() => ({ Start: () => gate, Pause: pause }) as unknown as ArchiveManager);
        const running = f.runner.Start(DefaultArchivePreferences, true);
        await expect(f.runner.Start(DefaultArchivePreferences, true)).rejects.toThrow('already');
        await vi.waitFor(() => expect(f.operations).toContain('queue-next'));
        await f.runner.Pause(); await running;
        expect(pause).toHaveBeenCalledOnce(); expect(f.pending).toHaveLength(1); expect(f.state()).toBe('Paused');
    });
    it('Should retain unavailable connectors for review instead of retrying endlessly', async () => {
        const factory = vi.fn(); const f = Fixture(factory, []);
        await f.runner.Start(DefaultArchivePreferences, true);
        expect(factory).not.toHaveBeenCalled(); expect(f.operations.filter(op => op === 'queue-result')).toHaveLength(2);
    });
    it('Should cancel only its owned manager and preserve unstarted work', async () => {
        let release: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const cancel = vi.fn(async () => release());
        const f = Fixture(() => ({ Start: () => gate, Cancel: cancel }) as unknown as ArchiveManager);
        const running = f.runner.Start(DefaultArchivePreferences, true);
        await vi.waitFor(() => expect(f.operations).toContain('queue-next'));
        await f.runner.Cancel(); await running;
        expect(cancel).toHaveBeenCalledOnce(); expect(f.pending).toHaveLength(1); expect(f.state()).toBe('Cancelled');
    });
});
