import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveRepository } from '../../../../app/electron/src/archive/ArchiveRepository';
import { DefaultArchivePreferences } from '../../../../app/electron/src/archive/ArchiveUIContract';
import type { ArchiveCoordinatorCommand } from '../../../../app/electron/src/archive/ArchiveCoordinatorProtocol';
import { ArchiveUIController } from './ArchiveUIController';
import { ArchiveClient } from './ArchiveClient';
import { DecoratableMangaScraper, type Manga } from '../providers/MangaPlugin';
import { SettingsManager } from '../SettingsManager';
import type { StorageController } from '../StorageController';
import { DownloadManager } from '../DownloadManager';

it('Should retain persisted Cancelled when a late ArchiveManager snapshot error reaches the UI failure handler', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-cancel-priority-'));
    const repository = new ArchiveRepository(path.join(base, 'profile', 'state.sqlite'));
    try {
        const directory = path.join(base, 'output'); await fs.mkdir(directory);
        const root = repository.GrantRoot(directory);
        const preferences = { ...structuredClone(DefaultArchivePreferences), rootId: root.rootId, policy: { ...structuredClone(DefaultArchivePreferences.policy), delayMs: 100 } };
        let rejectCatalog!: (error: Error) => void;
        let fetching = false;
        const pending = new Promise<Manga[]>((_resolve, reject) => { rejectCatalog = reject; });
        class LocalScraper extends DecoratableMangaScraper {
            constructor() { super('cancel-fixture', 'Cancel fixture', 'https://fixture.invalid'); }
            override async Initialize() {}
            override async FetchMangas(): Promise<Manga[]> { fetching = true; return pending; }
        }
        const storage = { LoadPersistent: async () => undefined, SavePersistent: async () => {} } as unknown as StorageController;
        const site = new LocalScraper().CreatePlugin(storage, new SettingsManager(storage));
        const sessionId = repository.UI.Create(site.Identifier, site.Title, preferences, true);
        let inject = true;
        const client = new ArchiveClient(async command => {
            try {
                if (command.operation === 'archive-run-snapshot' && repository.Work.Snapshot(sessionId).state === 'cancelled' && inject) {
                    inject = false; throw new Error('Injected late progress read failure after cancellation commit');
                }
                const value = command.operation === 'ui-progress' ? repository.UI.Progress(sessionId)
                    : command.operation === 'session' ? repository.Session(sessionId)
                        : command.operation === 'storage-check' ? undefined
                            : repository.Work.Execute(command as ArchiveCoordinatorCommand);
                return { ok: true, value };
            } catch(error) { return { ok: false, error: { kind: 'repository', message: String(error) } }; }
        });
        const controller = new ArchiveUIController(client, () => [site], new DownloadManager(storage));
        await controller.Start(sessionId);
        await vi.waitFor(() => expect(fetching).toBe(true));
        const cancelled = controller.Cancel(sessionId).catch(() => {});
        rejectCatalog(new Error('Late connector rejection after explicit cancel'));
        await cancelled;
        await vi.waitFor(() => expect(controller.IsRunning(sessionId)).toBe(false));
        expect(repository.UI.Session(sessionId).snapshot.state).toBe('cancelled');
        expect(repository.Session(sessionId).state).toBe('closed');
        expect(repository.UI.Progress(sessionId).events).toContainEqual(expect.objectContaining({ kind: 'late-error-after-cancel', reason: expect.stringContaining('Injected late progress read failure') }));
    } finally { repository.Close(); await fs.rm(base, { recursive: true, force: true }); }
});
