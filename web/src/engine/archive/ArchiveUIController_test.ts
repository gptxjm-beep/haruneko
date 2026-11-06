import { describe, it, expect, vi } from 'vitest';
import { ArchiveUIController, ArchiveUIError, GetArchiveUIController } from './ArchiveUIController';
import { ArchiveClient } from './ArchiveClient';
import { MangaPlugin } from '../providers/MangaPlugin';
import { ArchiveManager } from './ArchiveManager';
import type { DownloadManager } from '../DownloadManager';
import { DefaultArchivePreferences } from '../../../../app/electron/src/archive/ArchiveUIContract';

vi.mock('./ArchiveManager', () => ({ ArchiveManager: vi.fn() }));
function Fixture() {
    const site = Object.assign(Object.create(MangaPlugin.prototype), { entries: { Value: [] } });
    Object.defineProperties(site, { Identifier: { value: 'site-a' }, Title: { value: 'Site A' } });
    const other = Object.assign(Object.create(MangaPlugin.prototype), { entries: { Value: [] } });
    Object.defineProperties(other, { Identifier: { value: 'site-b' }, Title: { value: 'Site B' } });
    const invoke = vi.fn(async command => ({ ok: true as const, value: command.operation === 'ui-progress'
        ? { siteId: 'site-a', snapshot: { state: 'paused', policy: DefaultArchivePreferences.policy } } : command.operation === 'ui-create-session' ? 'session-a' : [] }));
    let finish!: () => void;
    const completion = new Promise<any>(resolve => { finish = () => resolve({}); });
    const manager = { Start: vi.fn(() => completion), Pause: vi.fn(async () => {}), Cancel: vi.fn(async () => {}) };
    vi.mocked(ArchiveManager).mockImplementation(function() { return manager as unknown as ArchiveManager; });
    const controller = new ArchiveUIController(new ArchiveClient(invoke), () => [site, other], {} as DownloadManager);
    return { site, other, invoke, manager, controller, finish };
}

describe('Archive UI renderer-lifetime ownership', () => {
    it('Should report unsupported browser environments without creating a controller', () => {
        vi.stubGlobal('ipcRenderer', undefined);
        try { expect(() => GetArchiveUIController()).toThrow('Electron desktop'); }
        finally { vi.unstubAllGlobals(); }
    });
    it('Should observe saved sessions without starting any download', async () => {
        const f = Fixture();
        await f.controller.Sessions(); await f.controller.Progress('session-a');
        expect(f.manager.Start).not.toHaveBeenCalled();
    });
    it('Should reject bookmarks, non-manga sources, missing sites and unconfirmed trials', async () => {
        const f = Fixture();
        for (const source of [undefined, {}, { Identifier: 'site-a' }]) await expect(f.controller.Create(source, DefaultArchivePreferences, true)).rejects.toThrow('supported');
        await expect(f.controller.Create(f.site, DefaultArchivePreferences, false)).rejects.toThrow('Confirm');
        expect(f.invoke).not.toHaveBeenCalled();
    });
    it('Should create only the captured website identity without starting it', async () => {
        const f = Fixture();
        await f.controller.Create(f.site, DefaultArchivePreferences, true);
        expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site-a', siteName: 'Site A', operation: 'ui-create-session' }));
        expect(f.manager.Start).not.toHaveBeenCalled();
    });
    it('Should deduplicate concurrent starts and continue without a mounted view', async () => {
        const f = Fixture();
        await Promise.all([f.controller.Start('session-a'), f.controller.Start('session-a'), f.controller.Start('session-a')]);
        await f.controller.Progress('session-a');
        expect(f.manager.Start).toHaveBeenCalledTimes(1);
        expect(f.controller.IsRunning('session-a')).toBe(true);
        expect(ArchiveManager).toHaveBeenLastCalledWith(f.site, expect.anything(), expect.anything(), 'session-a', DefaultArchivePreferences.policy);
        f.finish();
        await vi.waitFor(() => expect(f.controller.IsRunning('session-a')).toBe(false));
    });
    it('Should pause and cancel only the requested owned manager', async () => {
        const f = Fixture();
        await f.controller.Start('session-a');
        await f.controller.Pause('session-a');
        await f.controller.Cancel('session-a');
        expect(f.manager.Pause).toHaveBeenCalledOnce(); expect(f.manager.Cancel).toHaveBeenCalledOnce();
        f.finish();
    });
    it('Should bind resume to the persisted site rather than a later selection', async () => {
        const f = Fixture();
        await f.controller.Create(f.other, DefaultArchivePreferences, true);
        await f.controller.Start('session-a');
        expect(ArchiveManager).toHaveBeenLastCalledWith(f.site, expect.anything(), expect.anything(), 'session-a', DefaultArchivePreferences.policy);
        f.finish();
    });
    it('Should preserve a session if its original connector is no longer available', async () => {
        const f = Fixture();
        const controller = new ArchiveUIController(new ArchiveClient(f.invoke), () => [], {} as DownloadManager);
        await expect(controller.Start('session-a')).rejects.toThrow('unavailable');
        expect(f.manager.Start).not.toHaveBeenCalled();
    });
    it('Should hide private native paths and signed URLs in displayed exceptions', () => {
        expect(ArchiveUIError(new Error('Failure /home/private/file https://host.invalid/secret?token=abc cookie=a; b=secret'))).not.toMatch(/private|host|abc|b=secret/);
        expect(ArchiveUIError(new Error('Failure \\\\server\\private folder\\file.txt'))).not.toMatch(/server|private|folder|file/);
    });
});
