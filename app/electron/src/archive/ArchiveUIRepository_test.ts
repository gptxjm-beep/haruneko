import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MigrateArchiveDatabase } from './ArchiveSchema';
import { ArchiveWorkRepository } from './ArchiveWorkRepository';
import { ArchiveUIRepository, ArchivePublicMessage } from './ArchiveUIRepository';
import { DefaultArchivePreferences } from './ArchiveUIContract';

function Fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    MigrateArchiveDatabase(db);
    db.prepare("INSERT INTO roots(id,path,label) VALUES('root','/isolated-test','Test folder')").run();
    const work = new ArchiveWorkRepository(db);
    const ui = new ArchiveUIRepository(db, work);
    const preferences = { ...structuredClone(DefaultArchivePreferences), rootId: 'root' };
    return { db, work, ui, preferences };
}

describe('Main-process archiving preferences and UI receipts', () => {
    it('Should save validated defaults without native paths or changes to session policies', () => {
        const f = Fixture();
        try {
            const id = f.ui.Create('site', 'Site', f.preferences, true);
            const preferences = { ...f.preferences, format: 'application/pdf', policy: { ...f.preferences.policy, delayMs: 2000 } };
            f.ui.Save(preferences);
            expect(f.ui.Preferences()).toEqual(preferences);
            expect(f.ui.Session(id).snapshot.policy.delayMs).toBe(1000);
            expect(f.ui.Session(id).format).toBe('application/x-cbz');
            expect(JSON.stringify(f.ui.Progress(id))).not.toContain('/isolated-test');
        } finally { f.db.close(); }
    });
    it.each([0, 49, -1, 50.5, NaN, Infinity, 4097])('Should reject unsafe reserve %s', reserveGiB => {
        const f = Fixture();
        try { expect(() => f.ui.Save({ ...f.preferences, reserveGiB })).toThrow(); expect(f.ui.Preferences().reserveGiB).toBe(50); }
        finally { f.db.close(); }
    });
    it('Should reject injected roots, unsupported formats, unsafe limits and unconfirmed trials', () => {
        const f = Fixture();
        try {
            expect(() => f.ui.Save({ ...f.preferences, rootId: '/tmp/arbitrary' })).toThrow();
            expect(() => f.ui.Save({ ...f.preferences, format: 'shell' })).toThrow();
            expect(() => f.ui.Save({ ...f.preferences, policy: { ...f.preferences.policy, maxChapters: 21 } })).toThrow();
            expect(() => f.ui.Save({ ...f.preferences, policy: { ...f.preferences.policy, maxMangas: 6 } })).toThrow();
            expect(() => f.ui.Create('site', 'Site', f.preferences, false)).toThrow('confirmation');
            expect(f.ui.Sessions()).toHaveLength(0);
        } finally { f.db.close(); }
    });
    it('Should prepare paused sessions without opening runs and never reset budgets on observation', () => {
        const f = Fixture();
        try {
            const id = f.ui.Create('site', 'Site', f.preferences, true);
            f.db.prepare('UPDATE archive_runs SET chapters_started=17 WHERE session_id=?').run(id);
            for (let n = 0; n < 10; n++) expect(f.ui.Progress(id).snapshot).toMatchObject({ state: 'paused', chaptersStarted: 17, catalogState: 'idle' });
            expect(f.ui.Sessions()).toHaveLength(1);
            expect(f.ui.Progress(id).registeredChapters).toBe(0);
        } finally { f.db.close(); }
    });
    it('Should disallow reserve changes while sessions are open and allow changes after cancellation', () => {
        const f = Fixture();
        try {
            const id = f.ui.Create('site', 'Site', f.preferences, true);
            expect(() => f.ui.Save({ ...f.preferences, reserveGiB: 60 })).toThrow('cancel');
            f.work.Execute({ operation: 'archive-run-state', sessionId: id, state: 'cancelled', reason: 'User cancelled' });
            expect(f.ui.Save({ ...f.preferences, reserveGiB: 60 }).reserveGiB).toBe(60);
        } finally { f.db.close(); }
    });
    it('Should roll back session creation if policy insertion fails', () => {
        const f = Fixture();
        try {
            f.db.exec("CREATE TRIGGER reject_run BEFORE INSERT ON archive_runs BEGIN SELECT RAISE(ABORT,'injected transaction error'); END");
            expect(() => f.ui.Create('site', 'Site', f.preferences, true)).toThrow('injected');
            expect(f.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n).toBe(0);
        } finally { f.db.close(); }
    });
    it('Should safely migrate v5 while preserving old budgets and roll back a failed migration', () => {
        const db = new DatabaseSync(':memory:');
        try {
            MigrateArchiveDatabase(db, 5);
            db.exec("CREATE TABLE archive_ui_preferences(id INTEGER)");
            expect(() => MigrateArchiveDatabase(db)).toThrow();
            expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(5);
            db.exec('DROP TABLE archive_ui_preferences');
            MigrateArchiveDatabase(db);
            expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(8);
        } finally { db.close(); }
    });
    it('Should redact URLs, signed paths, credentials and native paths from public diagnostics', () => {
        const result = ArchivePublicMessage('Error https://host.invalid/signed-secret?token=foo C:\\Users\\private\\file /home/private/file cookie=a; b=secret');
        expect(result).not.toMatch(/host|signed-secret|foo|Users|private|b=secret/);
        expect(ArchivePublicMessage('Error \\\\server\\private folder\\file.txt')).not.toMatch(/server|private|folder|file/);
    });
    it('Should page saved sessions with stable cursors and no growing in-memory history', () => {
        const f = Fixture();
        try {
            for (let index = 0; index < 73; index++) f.ui.Create('site', `Site ${index}`, f.preferences, true);
            const first = f.ui.Sessions();
            const second = f.ui.Sessions(first.at(-1)!.cursor);
            expect(first).toHaveLength(50); expect(second).toHaveLength(23);
            expect(new Set([...first, ...second].map(session => session.id)).size).toBe(73);
        } finally { f.db.close(); }
    });
    it('Should preserve previous preferences when SQLite rejects the save', () => {
        const f = Fixture();
        try {
            f.ui.Save(f.preferences);
            f.db.exec("CREATE TRIGGER reject_preferences BEFORE UPDATE ON archive_ui_preferences BEGIN SELECT RAISE(ABORT,'injected preference failure'); END");
            expect(() => f.ui.Save({ ...f.preferences, format: 'application/pdf' })).toThrow('injected');
            expect(f.ui.Preferences().format).toBe('application/x-cbz');
        } finally { f.db.close(); }
    });
    it('Should display the manga owning the downloading chapter instead of another ready manga', () => {
        const f = Fixture();
        try {
            const id = f.ui.Create('site', 'Site', f.preferences, true);
            f.work.Execute({ operation: 'archive-run-open', sessionId: id, policy: f.preferences.policy });
            f.db.prepare("INSERT INTO archive_mangas(session_id,id,title,position,state) VALUES(?,'first','First manga',0,'ready'),(?,'second','Active manga',1,'ready')").run(id, id);
            f.db.exec("INSERT INTO chapters(key,site_id,manga_id,chapter_id) VALUES('chapter-key','site','second','chapter')");
            f.db.prepare("INSERT INTO archive_work(session_id,manga_id,id,chapter_key,title,position,state) VALUES(?,'second','chapter','chapter-key','Active chapter',0,'downloading')").run(id);
            expect(f.ui.Progress(id)).toMatchObject({ currentManga: 'Active manga', currentChapter: 'Active chapter', discoveredMangas: 2, registeredChapters: 1 });
        } finally { f.db.close(); }
    });
});
