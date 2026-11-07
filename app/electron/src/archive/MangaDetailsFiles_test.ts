import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveRepository } from './ArchiveRepository';
import { DefaultArchivePreferences } from './ArchiveUIContract';
import { MangaDetailsFiles } from './MangaDetailsFiles';
import type { ArchiveStorageController } from './ArchiveStorageController';
describe('Optional manga details files', () => {
    it('Should use the granted manga directory, protect existing text and retain an independent receipt', async () => {
        const base = await mkdtemp(path.join(os.tmpdir(), 'manga-details-'));
        const root = path.join(base, 'output'); await mkdir(root);
        const repository = new ArchiveRepository(path.join(base, 'db.sqlite'));
        try {
            const grant = repository.GrantRoot(root);
            repository.Queue.Execute({ operation: 'queue-add', reference: { siteId: 'test', siteName: 'Test', mangaId: '/manga/id/', title: 'Manga' } });
            repository.Queue.Execute({ operation: 'queue-open', preferences: { ...DefaultArchivePreferences, rootId: grant.rootId }, confirmed: true });
            const row = repository.Queue.Execute({ operation: 'queue-next' });
            const files = new MangaDetailsFiles(repository, { CheckSession: async () => {} } as unknown as ArchiveStorageController);
            expect(await files.Save(row.seq, { text: 'Known title', partial: true })).toBe('Partial');
            const text = path.join(root, 'Test', 'Manga', '00 - Manga Details', 'details.txt');
            expect(await readFile(text, 'utf8')).toBe('Known title');
            await files.Save(row.seq, { text: 'Changed text must not overwrite', partial: false });
            expect(await readFile(text, 'utf8')).toBe('Known title');
            expect(repository.Queue.Execute({ operation: 'queue-list' })[0].detailsState).toBe('Partial');
            expect(repository.Queue.Budget()).toEqual({ mangasUsed: 0, chaptersStarted: 0 });
            expect(repository.Work.Snapshot(row.sessionId).state).toBe('paused');
        } finally { repository.Close(); await rm(base, { recursive: true, force: true }); }
    });
});
