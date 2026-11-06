import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MigrateArchiveDatabase } from './ArchiveSchema';
import { ArchiveWorkRepository } from './ArchiveWorkRepository';
import type { ArchiveCoordinatorCommand } from './ArchiveCoordinatorProtocol';

function fixture() {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys=ON');
    MigrateArchiveDatabase(database);
    database.exec(`INSERT INTO roots(id,path,label) VALUES('root','/test','Test');
        INSERT INTO sessions(id,root_id,site_id,site_name,state,settings,started_at,updated_at) VALUES('session','root','site','Site','active','{}',0,0)`);
    const repository = new ArchiveWorkRepository(database);
    const policy = { maxMangas: 2, maxChapters: 3, delayMs: 1000, retryDelayMs: 1000, maxAttempts: 2, languages: [], unknownLanguage: 'include' as const };
    repository.Execute({ operation: 'archive-run-open', sessionId: 'session', policy });
    return { database, repository, policy };
}

describe('Persistent archive work queue', () => {
    it('Should roll back a failed v5 migration without changing existing v4 budgets', () => {
        const database = new DatabaseSync(':memory:');
        try {
            MigrateArchiveDatabase(database, 4);
            database.exec(`INSERT INTO roots(id,path,label) VALUES('r','/test','Test');
                INSERT INTO sessions(id,root_id,site_id,site_name,state,settings,started_at,updated_at) VALUES('s','r','site','Site','paused','{}',0,0);
                INSERT INTO archive_runs(session_id,state,policy,chapters_started) VALUES('s','paused','{}',17);
                ALTER TABLE archive_runs ADD COLUMN storage_error TEXT`);
            expect(() => MigrateArchiveDatabase(database)).toThrow();
            expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
            expect(database.prepare('SELECT chapters_started FROM archive_runs').get()!.chapters_started).toBe(17);
            database.exec('ALTER TABLE archive_runs DROP COLUMN storage_error');
            MigrateArchiveDatabase(database);
            expect(database.prepare('SELECT chapters_started,storage_error FROM archive_runs').get()).toMatchObject({ chapters_started: 17, storage_error: null });
        } finally { database.close(); }
    });

    it('Should keep the download budget and roll back all pause state when SQLite rejects a storage receipt', () => {
        const f = fixture();
        try {
            const command = (input: Record<string, unknown>) => f.repository.Execute({ sessionId: 'session', ...input } as ArchiveCoordinatorCommand);
            command({ operation: 'archive-catalog-page', items: [{ id: 'm', title: 'M' }] });
            command({ operation: 'archive-manga-begin', mangaId: 'm' });
            command({ operation: 'archive-manga-list', mangaId: 'm', chapters: [{ id: 'c', title: 'C', position: 0, language: null }], order: 'ascending', orderEvidence: 'Fixture', evidence: { state: 'unknown', evidence: '' } });
            command({ operation: 'archive-chapter-begin', mangaId: 'm', chapterId: 'c' });
            const stopped = { operation: 'archive-storage-stop', mangaId: 'm', chapterId: 'c', fault: { code: 'write-full', location: 'database' } };
            f.database.exec("CREATE TRIGGER fail_pause BEFORE UPDATE ON archive_runs WHEN NEW.storage_error IS NOT NULL BEGIN SELECT RAISE(ABORT,'database or disk is full'); END");
            expect(() => command(stopped)).toThrow('disk is full');
            expect(f.database.prepare('SELECT state,attempts FROM archive_work').get()).toMatchObject({ state: 'downloading', attempts: 1 });
            expect(f.repository.Snapshot('session').state).toBe('running');
            f.database.exec('DROP TRIGGER fail_pause');
            command(stopped);
            expect(f.repository.Snapshot('session')).toMatchObject({ state: 'paused', chaptersStarted: 1, storageError: { code: 'write-full' } });
            expect(f.database.prepare('SELECT state,attempts FROM archive_work').get()).toMatchObject({ state: 'pending', attempts: 0 });
            expect(f.database.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
        } finally { f.database.close(); }
    });
    it('Should migrate v2 atomically without leaving partial coordinator tables', () => {
        const database = new DatabaseSync(':memory:');
        try {
            MigrateArchiveDatabase(database, 2);
            database.exec('CREATE TABLE archive_work(test INTEGER)');
            expect(() => MigrateArchiveDatabase(database)).toThrow();
            expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
            expect(database.prepare("SELECT name FROM sqlite_master WHERE name='archive_runs'").get()).toBeUndefined();
            database.exec('DROP TABLE archive_work');
            MigrateArchiveDatabase(database);
            expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(5);
        } finally { database.close(); }
    });

    it('Should migrate v3 without resetting budgets and roll back a failed v4 migration', () => {
        const database = new DatabaseSync(':memory:');
        try {
            MigrateArchiveDatabase(database, 3);
            database.exec(`INSERT INTO roots(id,path,label) VALUES('r','/test','Test');
                INSERT INTO sessions(id,root_id,site_id,site_name,state,settings,started_at,updated_at) VALUES('s','r','site','Site','paused','{}',0,0);
                INSERT INTO archive_runs(session_id,state,policy,catalog_attempts,chapters_started) VALUES('s','paused','{}',2,17);
                CREATE TABLE archive_manifests(invalid INTEGER)`);
            expect(() => MigrateArchiveDatabase(database)).toThrow();
            expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
            expect(database.prepare('PRAGMA table_info(archive_runs)').all().some(row => row.name === 'catalog_active')).toBe(false);
            database.exec('DROP TABLE archive_manifests');
            MigrateArchiveDatabase(database);
            expect(database.prepare('SELECT catalog_attempts,chapters_started,catalog_state FROM archive_runs').get()).toMatchObject({ catalog_attempts: 2, chapters_started: 17, catalog_state: 'paused' });
        } finally { database.close(); }
    });

    it('Should detect duplicate identities and conflicting languages across chapter batches', () => {
        const f = fixture();
        try {
            const command = (input: Record<string, unknown>) => f.repository.Execute({ sessionId: 'session', ...input } as ArchiveCoordinatorCommand);
            command({ operation: 'archive-catalog-page', items: [{ id: 'm', title: 'M' }] });
            command({ operation: 'archive-manga-begin', mangaId: 'm' });
            const token = command({ operation: 'archive-manifest-begin', mangaId: 'm', count: 364, order: 'ascending', orderEvidence: 'Fixture', evidence: { state: 'unknown', evidence: '' } });
            const chapters = Array.from({ length: 364 }, (_, position) => ({ id: `c${position}`, title: `C${position}`, position, language: 'ar' }));
            chapters[205] = { ...chapters[0], position: 205 };
            chapters[363] = { ...chapters[1], position: 363, language: 'en' };
            command({ operation: 'archive-manifest-batch', mangaId: 'm', manifestId: token, offset: 0, chapters: chapters.slice(0, 200) });
            expect(command({ operation: 'archive-next-chapter', mangaId: 'm', now: Date.now() })).toBeNull();
            expect(() => command({ operation: 'archive-manifest-end', mangaId: 'm', manifestId: token })).toThrow('incomplete');
            command({ operation: 'archive-manifest-batch', mangaId: 'm', manifestId: token, offset: 200, chapters: chapters.slice(200) });
            command({ operation: 'archive-manifest-end', mangaId: 'm', manifestId: token });
            expect(f.database.prepare('SELECT count(*) AS n FROM archive_work').get()!.n).toBe(362);
            expect(f.database.prepare("SELECT state,position FROM archive_work WHERE id='c1'").get()).toMatchObject({ state: 'review', position: 1 });
            expect(f.database.prepare("SELECT position FROM archive_work WHERE id='c0'").get()!.position).toBe(0);
            expect(f.database.prepare("SELECT kind FROM archive_events WHERE kind='identity-conflict'").all().length).toBe(1);
            expect(f.database.prepare("SELECT kind FROM archive_events WHERE kind='duplicate-chapter'").all().length).toBe(1);
        } finally { f.database.close(); }
    });

    it('Should publish no partial work when finalizing a staged manifest fails', () => {
        const f = fixture();
        try {
            const command = (input: Record<string, unknown>) => f.repository.Execute({ sessionId: 'session', ...input } as ArchiveCoordinatorCommand);
            command({ operation: 'archive-catalog-page', items: [{ id: 'm', title: 'M' }] });
            command({ operation: 'archive-manga-begin', mangaId: 'm' });
            const token = command({ operation: 'archive-manifest-begin', mangaId: 'm', count: 2, order: 'ascending', orderEvidence: 'Fixture', evidence: { state: 'unknown', evidence: '' } });
            command({ operation: 'archive-manifest-batch', mangaId: 'm', manifestId: token, offset: 0, chapters: [0, 1].map(position => ({ id: `c${position}`, title: `C${position}`, position, language: null })) });
            f.database.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON archive_work WHEN NEW.id='c1' BEGIN SELECT RAISE(ABORT,'failure'); END");
            expect(() => command({ operation: 'archive-manifest-end', mangaId: 'm', manifestId: token })).toThrow();
            expect(f.database.prepare('SELECT count(*) AS n FROM archive_work').get()!.n).toBe(0);
            expect(f.database.prepare('SELECT count(*) AS n FROM chapters').get()!.n).toBe(0);
            expect(f.database.prepare('SELECT listed FROM archive_mangas').get()!.listed).toBe(0);
            expect(f.database.prepare('SELECT state,received_count FROM archive_manifests').get()).toMatchObject({ state: 'registering', received_count: 2 });
            f.database.exec('DROP TRIGGER fail_publish');
            command({ operation: 'archive-manifest-end', mangaId: 'm', manifestId: token });
            expect(f.database.prepare('SELECT count(*) AS n FROM archive_work').get()!.n).toBe(2);
        } finally { f.database.close(); }
    });
    it('Should deduplicate catalog pages and enforce bounded session budgets', () => {
        const f = fixture();
        try {
            f.repository.Execute({ operation: 'archive-catalog-page', sessionId: 'session', items: [{ id: 'm', title: 'M' }, { id: 'm', title: 'M' }] });
            expect(f.database.prepare('SELECT count(*) AS n FROM archive_mangas').get()!.n).toBe(1);
            expect(() => f.repository.Execute({ operation: 'archive-run-open', sessionId: 'session', policy: { ...f.policy, maxChapters: 1000 } })).toThrow();
        } finally { f.database.close(); }
    });

    it('Should roll back chapter snapshots and their event when persistence fails', () => {
        const f = fixture();
        try {
            f.repository.Execute({ operation: 'archive-catalog-page', sessionId: 'session', items: [{ id: 'm', title: 'M' }] });
            f.repository.Execute({ operation: 'archive-manga-begin', sessionId: 'session', mangaId: 'm' });
            f.database.exec("CREATE TRIGGER fail_work BEFORE INSERT ON archive_work BEGIN SELECT RAISE(ABORT,'failure'); END");
            expect(() => f.repository.Execute({ operation: 'archive-manga-list', sessionId: 'session', mangaId: 'm',
                chapters: [{ id: 'chapter', title: 'Special', position: 0, language: null }], order: 'ascending', orderEvidence: 'fixture', evidence: { state: 'unknown', evidence: '' } })).toThrow();
            expect(f.database.prepare('SELECT count(*) AS n FROM archive_work').get()!.n).toBe(0);
            expect(f.database.prepare('SELECT count(*) AS n FROM chapters').get()!.n).toBe(0);
        } finally { f.database.close(); }
    });
});
