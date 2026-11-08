import { ArchivePublicMessage } from './ArchiveUIRepository';
import type { DatabaseSync } from 'node:sqlite';
import { Count, Text } from './ArchivePaths';
import { ValidateQueueScope, type SelectiveQueueRepository } from './SelectiveQueueRepository';
import { CartQueueScope, type CartCommand, type CartSelection } from './SelectionCartContract';
export class SelectionCartRepository {
    constructor(private readonly db: DatabaseSync, private readonly queue: SelectiveQueueRepository) {}
    private Read(row: Record<string, any>): CartSelection {
        return { seq: Number(row.seq), siteId: String(row.site_id), siteName: String(row.site_name), mangaId: String(row.manga_id), title: String(row.title),
            revision: Number(row.revision ?? 0), chapterCount: row.chapter_count == null ? undefined : Number(row.chapter_count), mode: 'all', ids: [], order: 'source', ...JSON.parse(String(row.value ?? '{}')) };
    }
    private Rows(after = 0, summary = false): CartSelection[] {
        return this.db.prepare(`SELECT s.*,c.revision,${summary ? "json_remove(c.value,'$.chapters')" : 'c.value'} value,json_array_length(c.value,'$.chapters') chapter_count FROM hub_selections s LEFT JOIN hub_selection_scopes c ON c.selection_seq=s.seq WHERE s.seq>? ORDER BY s.seq LIMIT 100`).all(Count(after, 'selection cursor', Number.MAX_SAFE_INTEGER)).map(row => this.Read(row));
    }
    private Transaction<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE'); try { const value = action(); this.db.exec('COMMIT'); return value; } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    }
    public Execute(command: CartCommand): unknown {
        if (command.operation === 'cart-list') return this.Rows(command.after, true);
        if (command.operation === 'cart-transfer') {
            const result = { added: 0, existing: 0, review: 0 }; let after = 0;
            while (true) {
                const page = this.Rows(after); if (!page.length) break;
                for (const item of page) {
                    after = item.seq;
                    try { this.Transaction(() => {
                        const scope = ValidateQueueScope(CartQueueScope(item));
                        if (scope.mode === 'selected' && !scope.ids.length) throw new Error('No chapters selected');
                        const existing = this.db.prepare('SELECT * FROM hub_queue WHERE site_id=? AND manga_id=? AND removed=0').get(item.siteId, item.mangaId);
                        if (existing && JSON.stringify(ValidateQueueScope(JSON.parse(String(existing.scope)))) !== JSON.stringify(scope)) throw new Error('Downloads already has a different scope. Review or create a supplementary task there');
                        if (!existing) {
                            this.queue.Execute({ operation: 'queue-add', reference: item });
                            const row = this.db.prepare('SELECT seq FROM hub_queue WHERE site_id=? AND manga_id=?').get(item.siteId, item.mangaId)!;
                            this.queue.Execute({ operation: 'queue-edit', seq: Number(row.seq), action: 'up', scope });
                        }
                        this.db.prepare('DELETE FROM hub_selections WHERE seq=?').run(item.seq);
                        result[existing ? 'existing' : 'added']++;
                    }); } catch(error) {
                        result.review++;
                        const value = { ...item, reason: ArchivePublicMessage((error as Error)?.message ?? 'Selection transfer failed') };
                        const stored = { mode: value.mode, ids: value.ids, order: value.order, direction: value.direction, chapters: value.chapters, reason: value.reason };
                        this.db.prepare('INSERT INTO hub_selection_scopes(selection_seq,revision,value) VALUES(?,?,?) ON CONFLICT(selection_seq) DO UPDATE SET revision=hub_selection_scopes.revision+1,value=excluded.value').run(item.seq, item.revision + 1, JSON.stringify(stored));
                    }
                }
            }
            return result;
        }
        return this.Transaction(() => {
            if (command.operation === 'cart-supplement') {
                if (command.confirmed !== true) throw new Error('Confirm supplementary transfer');
                const row = this.db.prepare('SELECT s.*,c.revision,c.value FROM hub_selections s LEFT JOIN hub_selection_scopes c ON c.selection_seq=s.seq WHERE s.seq=?').get(Count(command.seq, 'cart item', Number.MAX_SAFE_INTEGER));
                if (!row || Number(row.revision ?? 0) !== command.expectedRevision) throw new Error('Selection changed; reload before transferring');
                const item = this.Read(row), scope = ValidateQueueScope(CartQueueScope(item));
                if (scope.mode === 'selected' && !scope.ids.length) throw new Error('No chapters selected');
                const queued = this.db.prepare('SELECT * FROM hub_queue WHERE site_id=? AND manga_id=? AND removed=0').get(item.siteId, item.mangaId);
                if (!queued) throw new Error('Download task is no longer available; retry ordinary transfer');
                this.queue.Execute(queued.session_id ? { operation: 'queue-supplement', seq: Number(queued.seq), scope, confirmed: true } : { operation: 'queue-edit', seq: Number(queued.seq), action: 'up', scope });
                this.db.prepare('DELETE FROM hub_selections WHERE seq=?').run(item.seq); return;
            }
            if (command.operation === 'cart-clear') {
                if (command.confirmed !== true) throw new Error('Confirm clearing the cart');
                this.db.exec('DELETE FROM hub_selections'); return;
            }
            if (command.operation === 'cart-remove') {
                const row = this.db.prepare('SELECT revision FROM hub_selection_scopes WHERE selection_seq=?').get(command.seq);
                if (Number(row?.revision ?? 0) !== command.expectedRevision || command.confirmed !== true) throw new Error('Selection changed; review before removing');
                this.db.prepare('DELETE FROM hub_selections WHERE seq=?').run(command.seq); return;
            }
            if (command.operation !== 'cart-save') throw new Error('Unsupported cart command');
            const ref = command.reference, selection = command.selection;
            Text(ref?.siteId, 'site'); Text(ref?.mangaId, 'manga'); Text(ref?.title, 'title', 4096); Text(ref?.siteName, 'site name');
            if (!selection || !['all', 'selected', 'except'].includes(selection.mode)) throw new Error('Invalid cart selection');
            const validated = ValidateQueueScope({ mode: 'selected', ids: selection.ids, order: selection.order, direction: selection.direction });
            if (selection.chapters && (!Array.isArray(selection.chapters) || selection.chapters.length > 100000)) throw new Error('Invalid source snapshot');
            let chapters = selection.chapters?.map(chapter => ({ id: Text(chapter.id, 'chapter'), title: Text(chapter.title, 'chapter title', 4096) }));
            if (chapters && new Set(chapters.map(chapter => chapter.id)).size !== chapters.length) throw new Error('Duplicate chapter identities need review');
            const old = this.db.prepare('SELECT s.seq,c.revision,c.value FROM hub_selections s LEFT JOIN hub_selection_scopes c ON c.selection_seq=s.seq WHERE site_id=? AND manga_id=?').get(ref.siteId, ref.mangaId);
            if (Number(old?.revision ?? 0) !== Count(command.expectedRevision, 'selection revision', Number.MAX_SAFE_INTEGER)) throw new Error('Selection changed; reload before saving');
            const before = JSON.parse(String(old?.value ?? '{}'));
            chapters ??= before.chapters;
            // A late source refresh cannot silently redefine an explicit selection or its source order.
            if (before.chapters && chapters && JSON.stringify(before.chapters.map((chapter: { id: string }) => chapter.id)) !== JSON.stringify(chapters.map(chapter => chapter.id))) throw new Error('Source chapter identities changed; retain the saved selection and review');
            const available = new Set(chapters?.map(chapter => chapter.id));
            if (chapters && selection.ids.some(id => !available.has(id))) throw new Error('Selected identity is absent from the chapter snapshot');
            // Unknown All is symbolic. Only an explicitly empty scope (or a known empty
            // complement) means deselection; validate revisions and snapshots before removal.
            if (selection.mode === 'selected' && !selection.ids.length || selection.mode === 'except' && chapters?.length && selection.ids.length === chapters.length) {
                if (old) this.db.prepare('DELETE FROM hub_selections WHERE seq=?').run(old.seq);
                return;
            }
            this.db.prepare('INSERT OR IGNORE INTO hub_selections(site_id,manga_id,title,site_name) VALUES(?,?,?,?)').run(ref.siteId, ref.mangaId, ref.title, ref.siteName);
            const seq = this.db.prepare('SELECT seq FROM hub_selections WHERE site_id=? AND manga_id=?').get(ref.siteId, ref.mangaId)!.seq;
            this.db.prepare('INSERT INTO hub_selection_scopes(selection_seq,revision,value) VALUES(?,?,?) ON CONFLICT(selection_seq) DO UPDATE SET revision=excluded.revision,value=excluded.value')
                .run(seq, command.expectedRevision + 1, JSON.stringify({ mode: selection.mode, order: validated.order ?? 'source', direction: validated.direction, ids: validated.mode === 'selected' ? validated.ids : [], chapters }));
        });
    }
}
