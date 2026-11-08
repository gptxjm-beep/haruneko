import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveRepository } from './ArchiveRepository';
import { DefaultArchivePreferences } from './ArchiveUIContract';
import { MangaInfoEditor } from './MangaInfoEditor';
import { RenderMangaMetadata } from './MangaMetadata';
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
            const files = new MangaDetailsFiles(repository, { CheckSession: async () => {}, Metadata: async () => {} } as unknown as ArchiveStorageController);
            expect(await files.Save(row.seq, { text: 'Known title', partial: true })).toBe('Partial');
            const text = path.join(root, 'Test', 'Manga', '00 - Manga Details', 'details.txt');
            expect(await readFile(text, 'utf8')).toBe('Known title');
            await files.Save(row.seq, { text: 'Changed text must not overwrite', partial: false });
            expect(await readFile(text, 'utf8')).toBe('Known title');
            expect(repository.Queue.Execute({ operation: 'queue-list' })[0].detailsState).toBe('Partial');
            expect(repository.Queue.Budget()).toEqual({ mangasUsed: 0, chaptersStarted: 0 });
            expect(repository.Work.Snapshot(row.sessionId).state).toBe('paused');
            const metadata = { schema: 1 as const, title: 'قصة <script>alert(1)</script>', sourceName: 'Test', fields: { Description: 'Real story & details' } };
            await files.Save(row.seq, { metadata, partial: false });
            const folder = path.dirname(text), json = JSON.parse(await readFile(path.join(folder, 'metadata.json'), 'utf8'));
            expect(json.title).toBe(metadata.title);
            const html = await readFile(path.join(path.dirname(folder), '00 - Manga Details.html'), 'utf8');
            expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
            expect(html).toBe(RenderMangaMetadata(json, '00 - Manga Details/'));
            expect(html).toContain("default-src 'none'"); expect(html).not.toContain('Registered');
            await files.Save(row.seq, { metadata: { ...metadata, fields: { Description: 'Must not overwrite' } }, partial: false });
            expect(JSON.parse(await readFile(path.join(folder, 'metadata.json'), 'utf8')).fields.Description).toBe('Real story & details');
            const editor = new MangaInfoEditor(repository, files, { Metadata: async () => {} } as unknown as ArchiveStorageController);
            const draft = await editor.Read(row.seq); draft.metadata.title = 'Edited title'; draft.metadata.fields.Description = 'User story';
            await editor.Save(row.seq, draft, true);
            expect(JSON.parse(await readFile(path.join(folder, 'metadata.json'), 'utf8')).title).toBe('Edited title');
            expect(await readFile(path.join(path.dirname(folder), '00 - Manga Details.html'), 'utf8')).toContain('User story');
            await expect(editor.Save(row.seq, draft, true)).rejects.toThrow('Files changed');
            await expect((await import('node:fs/promises')).readdir(folder).then(names => names.some(name => name.startsWith('backup-')))).resolves.toBe(true);

        } finally { repository.Close(); await rm(base, { recursive: true, force: true }); }
    });
});
