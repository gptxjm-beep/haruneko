import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MigrateArchiveDatabase } from './ArchiveSchema';
import { SelectiveQueueRepository } from './SelectiveQueueRepository';
import { ArchiveUIRepository } from './ArchiveUIRepository';
import { ArchiveWorkRepository } from './ArchiveWorkRepository';
import { SelectionCartRepository } from './SelectionCartRepository';
import type { CartSelection } from './SelectionCartContract';
const ref = { siteId: 'a', siteName: 'A', mangaId: 'm', title: 'M' };
function fixture() {
    const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); MigrateArchiveDatabase(db, 10);
    db.prepare('INSERT INTO hub_selections(site_id,manga_id,title,site_name) VALUES(?,?,?,?)').run(ref.siteId, ref.mangaId, ref.title, ref.siteName);
    MigrateArchiveDatabase(db);
    const work = new ArchiveWorkRepository(db), queue = new SelectiveQueueRepository(db, new ArchiveUIRepository(db, work), work);
    return { db, queue, cart: new SelectionCartRepository(db, queue) };
}
describe('Unified durable selection cart', () => {
    it('Should migrate v10 selections intact, persist exclusions and reject stale source results without resetting queue budgets', () => {
        const f = fixture(); try {
            const first = (f.cart.Execute({ operation: 'cart-list' }) as CartSelection[])[0]; expect(first).toMatchObject({ ...ref, mode: 'all', revision: 0 });
            const selection = { mode: 'except' as const, ids: ['two'], order: 'source' as const, chapters: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] };
            f.cart.Execute({ operation: 'cart-save', reference: ref, expectedRevision: 0, selection });
            expect(() => f.cart.Execute({ operation: 'cart-save', reference: ref, expectedRevision: 0, selection })).toThrow('Selection changed');
            const restored = new SelectionCartRepository(f.db, f.queue);
            expect((restored.Execute({ operation: 'cart-list' }) as CartSelection[])[0]).toMatchObject({ mode: 'except', ids: ['two'], revision: 1 });
            expect(() => restored.Execute({ operation: 'cart-save', reference: ref, expectedRevision: 1, selection: { ...selection, chapters: [{ id: 'new', title: 'New' }] } })).toThrow('identities changed');
            expect(f.queue.Budget()).toEqual({ mangasUsed: 0, chaptersStarted: 0 });
        } finally { f.db.close(); }
    });
    it('Should transfer exact scoped identities transactionally, clear successes, retain conflicting scopes and separate sources', () => {
        const f = fixture(); try {
            f.cart.Execute({ operation: 'cart-save', reference: ref, expectedRevision: 0, selection: { mode: 'selected', ids: ['one'], order: 'source' } });
            expect(f.cart.Execute({ operation: 'cart-transfer' })).toEqual({ added: 1, existing: 0, review: 0 });
            expect(f.cart.Execute({ operation: 'cart-list' })).toEqual([]);
            expect(f.queue.Execute({ operation: 'queue-list' })[0].scope.ids).toEqual(['one']);
            expect(f.db.prepare('SELECT count(*) n FROM sessions').get()!.n).toBe(0);
            f.cart.Execute({ operation: 'cart-save', reference: ref, expectedRevision: 0, selection: { mode: 'selected', ids: ['two'], order: 'source' } });
            f.cart.Execute({ operation: 'cart-save', reference: { ...ref, siteId: 'b' }, expectedRevision: 0, selection: { mode: 'all', ids: [], order: 'source' } });
            expect(f.cart.Execute({ operation: 'cart-transfer' })).toEqual({ added: 1, existing: 0, review: 1 });
            expect((f.cart.Execute({ operation: 'cart-list' }) as CartSelection[]).map(item => item.siteId)).toEqual(['a']);
            expect(f.queue.Execute({ operation: 'queue-list' })).toHaveLength(2); expect(f.queue.Budget().chaptersStarted).toBe(0);
        } finally { f.db.close(); }
    });
});
