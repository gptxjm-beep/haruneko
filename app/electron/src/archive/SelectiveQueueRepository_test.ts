import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MigrateArchiveDatabase } from './ArchiveSchema';
import { ArchiveWorkRepository } from './ArchiveWorkRepository';
import { ArchiveUIRepository } from './ArchiveUIRepository';
import { SelectiveQueueRepository } from './SelectiveQueueRepository';
import type { QueueManga } from './SelectiveQueueContract';
import { DefaultArchivePreferences } from './ArchiveUIContract';

function Fixture() {
    const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); MigrateArchiveDatabase(db);
    db.exec("INSERT INTO roots(id,path,label) VALUES('root','/isolated-test','Test')");
    const work = new ArchiveWorkRepository(db), ui = new ArchiveUIRepository(db, work);
    const queue = new SelectiveQueueRepository(db, ui, work);
    const reference = (mangaId: string, siteId = 'site') => ({ siteId, mangaId, title: 'Same title', siteName: siteId });
    const preferences = { ...structuredClone(DefaultArchivePreferences), rootId: 'root' };
    return { db, queue, reference, preferences, work, ui };
}
describe('Persistent selective queue', () => {
    it('Should retain selection order and source identity independently of search and favorites', () => {
        const f = Fixture();
        try {
            for (const ref of [f.reference('b'), f.reference('a'), f.reference('a', 'other')]) f.queue.Execute({ operation: 'queue-select', reference: ref, selected: true });
            f.queue.Execute({ operation: 'queue-select', reference: f.reference('b'), selected: true });
            const restored = new SelectiveQueueRepository(f.db, new ArchiveUIRepository(f.db, f.work), f.work);
            expect(restored.Execute({ operation: 'queue-selections' }).map((row: QueueManga) => [row.siteId, row.mangaId])).toEqual([['site', 'b'], ['site', 'a'], ['other', 'a']]);
            expect(f.queue.Execute({ operation: 'queue-summary' }).selected).toBe(3);
            expect(f.queue.Execute({ operation: 'queue-add' })).toEqual({ added: 3, existing: 0 });
            expect(f.queue.Execute({ operation: 'queue-selected', references: [f.reference('a'), f.reference('a', 'other')] })).toEqual([{ selected: true, queued: true }, { selected: true, queued: true }]);
        } finally { f.db.close(); }
    });
    it('Should add individual and selected references idempotently without creating archive sessions', () => {
        const f = Fixture();
        try {
            f.queue.Execute({ operation: 'queue-select', reference: f.reference('a'), selected: true });
            expect(f.queue.Execute({ operation: 'queue-add', reference: f.reference('b') })).toMatchObject({ added: 1, existing: 0 });
            expect(f.queue.Execute({ operation: 'queue-add' })).toMatchObject({ added: 1 });
            expect(f.queue.Execute({ operation: 'queue-add' })).toMatchObject({ added: 0, existing: 1 });
            expect(f.queue.Execute({ operation: 'queue-list' }).map((row: QueueManga) => row.mangaId)).toEqual(['b', 'a']);
            expect(f.db.prepare('SELECT count(*) n FROM sessions').get()!.n).toBe(0);
        } finally { f.db.close(); }
    });
    it('Should preserve more than five queued entries, reorder and remove without deleting receipts', () => {
        const f = Fixture();
        try {
            for (let n = 0; n < 12; n++) f.queue.Execute({ operation: 'queue-add', reference: f.reference(String(n)) });
            let rows = f.queue.Execute({ operation: 'queue-list' });
            f.queue.Execute({ operation: 'queue-edit', seq: rows[1].seq, action: 'up' });
            rows = f.queue.Execute({ operation: 'queue-list' }); expect(rows[0].mangaId).toBe('1');
            f.queue.Execute({ operation: 'queue-edit', seq: rows[0].seq, action: 'remove' });
            expect(f.queue.Execute({ operation: 'queue-summary' }).queued).toBe(11);
            expect(f.db.prepare('SELECT count(*) n FROM hub_queue').get()!.n).toBe(12);
        } finally { f.db.close(); }
    });
    it('Should prepare exactly one durable session per item and resume it after interruption without resetting budgets', () => {
        const f = Fixture();
        try {
            f.queue.Execute({ operation: 'queue-add', reference: f.reference('a') });
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            const first = f.queue.Execute({ operation: 'queue-next' });
            expect(f.queue.Execute({ operation: 'queue-next' }).sessionId).toBe(first.sessionId);
            f.db.prepare('UPDATE archive_runs SET mangas_used=1,chapters_started=7 WHERE session_id=?').run(first.sessionId);
            f.queue.Recover();
            expect(f.queue.Summary()).toMatchObject({ state: 'Interrupted', mangasUsed: 1, chaptersStarted: 7 });
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            expect(f.queue.Execute({ operation: 'queue-next' }).sessionId).toBe(first.sessionId);
            expect(f.db.prepare('SELECT count(*) n FROM sessions').get()!.n).toBe(1);
            expect(f.queue.Summary().chaptersStarted).toBe(7);
        } finally { f.db.close(); }
    });
    it('Should enforce one cumulative five-manga budget across sites and leave excess entries queued', () => {
        const f = Fixture();
        try {
            for (let n = 0; n < 12; n++) f.queue.Execute({ operation: 'queue-add', reference: f.reference(String(n), `site-${n}`) });
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            for (let n = 0; n < 5; n++) {
                const item = f.queue.Execute({ operation: 'queue-next' });
                f.work.Execute({ operation: 'archive-run-open', sessionId: item.sessionId, policy: f.preferences.policy });
                f.work.Execute({ operation: 'archive-manga-begin', sessionId: item.sessionId, mangaId: item.mangaId });
                f.work.Execute({ operation: 'archive-run-state', sessionId: item.sessionId, state: 'review', reason: 'Fixture review' });
                f.queue.Execute({ operation: 'queue-result', seq: item.seq });
            }
            expect(f.queue.Execute({ operation: 'queue-next' })).toBeNull();
            expect(f.queue.Summary()).toMatchObject({ state: 'Limited', mangasUsed: 5, queued: 12 });
            expect(f.queue.Execute({ operation: 'queue-list' }).filter((row: QueueManga) => row.state === 'Queued')).toHaveLength(7);
            f.queue.Execute({ operation: 'queue-stop', state: 'Paused', reason: 'pause' });
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            expect(f.queue.Execute({ operation: 'queue-next' })).toBeNull();
        } finally { f.db.close(); }
    });
    it('Should enforce twenty attempts in main even across sites and preserve them after removal', () => {
        const f = Fixture();
        try {
            f.queue.Execute({ operation: 'queue-add', reference: f.reference('a') });
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            const item = f.queue.Execute({ operation: 'queue-next' }), sessionId = item.sessionId;
            f.work.Execute({ operation: 'archive-run-open', sessionId, policy: f.preferences.policy });
            f.work.Execute({ operation: 'archive-manga-begin', sessionId, mangaId: 'a' });
            f.work.Execute({ operation: 'archive-manga-list', sessionId, mangaId: 'a', chapters: ['one', 'two'].map((id, position) => ({ id, title: id, position, language: 'ar' })), order: 'ascending', orderEvidence: 'Fixture sequence', evidence: { state: 'unknown', evidence: 'Fixture only' } });
            f.db.prepare('UPDATE archive_runs SET chapters_started=19 WHERE session_id=?').run(sessionId);
            f.work.Execute({ operation: 'archive-chapter-begin', sessionId, mangaId: 'a', chapterId: 'one' });
            expect(() => f.work.Execute({ operation: 'archive-chapter-begin', sessionId, mangaId: 'a', chapterId: 'two' })).toThrow('limit');
            f.work.Execute({ operation: 'archive-run-state', sessionId, state: 'limited', reason: '20 cap' });
            f.queue.Execute({ operation: 'queue-result', seq: item.seq });
            f.queue.Execute({ operation: 'queue-edit', seq: item.seq, action: 'remove' });
            f.queue.Execute({ operation: 'queue-add', reference: f.reference('b', 'other') });
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            expect(f.queue.Execute({ operation: 'queue-next' })).toBeNull(); expect(f.queue.Summary().chaptersStarted).toBe(20);
        } finally { f.db.close(); }
    });
    it('Should roll back preparation atomically and refuse conflicting starts, policy changes and forged completion', () => {
        const f = Fixture();
        try {
            f.queue.Execute({ operation: 'queue-add', reference: f.reference('a') });
            expect(() => f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: false })).toThrow();
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            expect(() => f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true })).toThrow('already');
            f.db.exec("CREATE TRIGGER fail_queue_prepare BEFORE UPDATE OF session_id ON hub_queue BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END");
            expect(() => f.queue.Execute({ operation: 'queue-next' })).toThrow();
            expect(f.db.prepare('SELECT count(*) n FROM sessions').get()!.n).toBe(0);
            f.db.exec('DROP TRIGGER fail_queue_prepare');
            const item = f.queue.Execute({ operation: 'queue-next' });
            f.work.Execute({ operation: 'archive-run-open', sessionId: item.sessionId, policy: f.preferences.policy });
            expect(() => f.queue.Execute({ operation: 'queue-result', seq: item.seq })).toThrow('not ended');
            expect(() => f.queue.Execute({ operation: 'queue-result', seq: item.seq, reason: 'Cannot bypass the active owner' })).toThrow('not ended');
            expect(() => f.queue.Execute({ operation: 'queue-stop', state: 'Paused', reason: 'Cannot bypass the active owner' })).toThrow('owned');
            f.work.Execute({ operation: 'archive-run-state', sessionId: item.sessionId, state: 'review', reason: 'Unknown order' });
            f.queue.Execute({ operation: 'queue-result', seq: item.seq });
            expect(f.queue.Execute({ operation: 'queue-list' })[0].state).toBe('Review');
            f.queue.Execute({ operation: 'queue-stop', state: 'Paused', reason: 'pause' });
            expect(() => f.queue.Execute({ operation: 'queue-open', preferences: { ...f.preferences, format: 'application/pdf' }, confirmed: true })).toThrow('frozen');
        } finally { f.db.close(); }
    });
    it('Should migrate v8 transactionally without touching existing archive data', () => {
        const db = new DatabaseSync(':memory:');
        try {
            MigrateArchiveDatabase(db, 8); db.exec("INSERT INTO roots(id,path,label) VALUES('r','/fixture','Test'); INSERT INTO sessions(id,root_id,site_id,site_name,state,settings,started_at,updated_at) VALUES('old','r','s','S','paused','{}',1,1); INSERT INTO archive_runs(session_id,state,policy,mangas_used,chapters_started) VALUES('old','review','{}',4,17)");
            db.exec('CREATE TABLE hub_queue(seq INTEGER)');
            expect(() => MigrateArchiveDatabase(db)).toThrow(); expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(8);
            expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='hub_selections'").get()).toBeUndefined();
            db.exec('DROP TABLE hub_queue'); MigrateArchiveDatabase(db);
            expect(db.prepare('SELECT mangas_used,chapters_started FROM archive_runs WHERE session_id=?').get('old')).toMatchObject({ mangas_used: 4, chapters_started: 17 });
            expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(9);
        } finally { db.close(); }
    });
    it('Should freeze the reserve between selective tasks even before a child run has started', () => {
        const f = Fixture();
        try {
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            expect(() => f.ui.Save({ ...f.preferences, reserveGiB: 60 })).toThrow('selective queue');
            expect(f.ui.Preferences().reserveGiB).toBe(50);
        } finally { f.db.close(); }
    });
    it('Should release an unavailable prepared connector into review without leaving an open paused run', () => {
        const f = Fixture();
        try {
            f.queue.Execute({ operation: 'queue-add', reference: f.reference('missing') });
            f.queue.Execute({ operation: 'queue-open', preferences: f.preferences, confirmed: true });
            const item = f.queue.Execute({ operation: 'queue-next' });
            f.queue.Execute({ operation: 'queue-result', seq: item.seq, reason: 'Original connector unavailable' });
            expect(f.work.Snapshot(item.sessionId).state).toBe('review');
            f.queue.Execute({ operation: 'queue-stop', state: 'Cancelled', reason: 'User cancelled' });
            expect(f.ui.Save({ ...f.preferences, reserveGiB: 60 }).reserveGiB).toBe(60);
        } finally { f.db.close(); }
    });
});
