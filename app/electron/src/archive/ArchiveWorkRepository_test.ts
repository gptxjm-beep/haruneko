import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MigrateArchiveDatabase } from './ArchiveSchema';
import { ArchiveWorkRepository } from './ArchiveWorkRepository';

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
            expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
        } finally { database.close(); }
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
