import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Count, Text } from './ArchivePaths';
import { ArchivePublicMessage, type ArchiveUIRepository } from './ArchiveUIRepository';
import type { ArchiveWorkRepository } from './ArchiveWorkRepository';
import type { MangaReference, QueueManga, QueueScope, QueueSnapshot, SelectiveQueueCommand } from './SelectiveQueueContract';

export function ValidateQueueScope(scope: QueueScope): QueueScope {
    if (scope?.mode === 'all' || scope?.mode === 'missing') return { mode: scope.mode };
    if (scope?.mode !== 'range') throw new Error('Unsupported chapter scope');
    const from = Count(scope.from, 'first oldest-first chapter', Number.MAX_SAFE_INTEGER), to = Count(scope.to, 'last oldest-first chapter', Number.MAX_SAFE_INTEGER);
    if (!from || to < from) throw new Error('Invalid chapter range');
    return { mode: 'range', from, to };
}
/** SQLite is the sole authority for selections, queue order and task identity. No files are removed here. */
export class SelectiveQueueRepository {
    constructor(private readonly db: DatabaseSync, private readonly ui: ArchiveUIRepository, private readonly work: ArchiveWorkRepository) {}
    private Transaction<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const value = action(); this.db.exec('COMMIT'); return value; }
        catch(error) { this.db.exec('ROLLBACK'); throw error; }
    }
    private Reference(ref: MangaReference): MangaReference {
        return { siteId: Text(ref?.siteId, 'site ID'), mangaId: Text(ref?.mangaId, 'manga ID'), title: Text(ref?.title, 'manga title', 4096), siteName: Text(ref?.siteName, 'site name') };
    }
    private Row(row: Record<string, any>): QueueManga {
        let state = row.state;
        let progress: QueueManga['progress'];
        if (row.session_id) {
            const detail = this.ui.Progress(String(row.session_id));
            progress = { registered: detail.registeredChapters, verified: detail.verifiedChapters, bytes: detail.writtenBytes, chapter: detail.currentChapter,
                storage: detail.snapshot.storageError ? `${detail.snapshot.storageError.code} (${detail.snapshot.storageError.location})` : null };
        }
        if (row.session_id && state === 'Preparing') {
            const snapshot = this.work.Snapshot(String(row.session_id));
            if (snapshot.state === 'running' && snapshot.counts.downloading) state = 'Downloading';
        }
        return { seq: Number(row.seq), siteId: String(row.site_id), mangaId: String(row.manga_id), title: String(row.title), siteName: String(row.site_name),
            state, reason: ArchivePublicMessage(row.reason), sessionId: row.session_id as string | null, scope: JSON.parse(String(row.scope ?? '{"mode":"all"}')), progress,
            inCurrentRun: !!this.db.prepare('SELECT 1 FROM hub_queue_batch_members m JOIN hub_queue_control c ON c.batch_id=m.batch_id WHERE m.queue_seq=? AND m.enqueue_version=?').get(row.seq, row.enqueue_version ?? 1) };
    }
    private Control() { return this.db.prepare('SELECT * FROM hub_queue_control WHERE id=1').get()!; }
    public Budget(): { mangasUsed: number; chaptersStarted: number } {
        const row = this.db.prepare('SELECT coalesce(sum(r.mangas_used),0) m,coalesce(sum(r.chapters_started),0) c FROM archive_runs r JOIN hub_queue q ON q.session_id=r.session_id').get()!;
        return { mangasUsed: Number(row.m), chaptersStarted: Number(row.c) };
    }
    public Summary(): QueueSnapshot {
        const control = this.Control();
        const preferences = control.preferences ? JSON.parse(String(control.preferences)) : null;
        return { ...this.Budget(), selected: Number(this.db.prepare('SELECT count(*) n FROM hub_selections').get()!.n),
            queued: Number(this.db.prepare('SELECT count(*) n FROM hub_queue WHERE removed=0').get()!.n), state: String(control.state), reason: ArchivePublicMessage(control.reason),
            preferences, rootLabel: this.ui.RootLabel(preferences?.rootId ?? null), batchId: control.batch_id ? String(control.batch_id) : null,
            waitingNextRun: Number(this.db.prepare("SELECT count(*) n FROM hub_queue q WHERE removed=0 AND state IN ('Queued','Paused') AND NOT EXISTS (SELECT 1 FROM hub_queue_batch_members m WHERE m.batch_id=? AND m.queue_seq=q.seq AND m.enqueue_version=q.enqueue_version)").get(control.batch_id ?? null)!.n) };
    }
    /** Called inside startup recovery. Neither deletion nor renderer reload can reset cumulative counters. */
    public Recover(): void {
        if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='hub_queue'").get()) return;
        this.db.exec("UPDATE hub_queue_control SET state='Interrupted',reason='Application stopped; explicit resume required',current_seq=NULL WHERE state='Running'; UPDATE hub_queue SET state='Paused',reason='Interrupted; reconcile saved files on resume' WHERE state IN ('Preparing','Downloading')");
    }
    public Execute(command: SelectiveQueueCommand): any {
        if (command.operation === 'queue-summary') return this.Summary();
        if (command.operation === 'queue-selections') return this.db.prepare('SELECT * FROM hub_selections WHERE seq>? ORDER BY seq LIMIT 50').all(Count(command.after ?? 0, 'selection cursor', Number.MAX_SAFE_INTEGER)).map(row => this.Row(row));
        if (command.operation === 'queue-list') return this.db.prepare('SELECT * FROM hub_queue WHERE removed=0 ORDER BY priority,seq LIMIT 50 OFFSET ?').all(Count(command.offset ?? 0, 'queue offset', Number.MAX_SAFE_INTEGER)).map(row => this.Row(row));
        if (command.operation === 'queue-selected') {
            if (!Array.isArray(command.references) || command.references.length > 50) throw new Error('Invalid selection page');
            return command.references.map(reference => {
                const ref = this.Reference(reference);
                return { selected: !!this.db.prepare('SELECT 1 FROM hub_selections WHERE site_id=? AND manga_id=?').get(ref.siteId, ref.mangaId),
                    queued: !!this.db.prepare('SELECT 1 FROM hub_queue WHERE site_id=? AND manga_id=? AND removed=0').get(ref.siteId, ref.mangaId) };
            });
        }
        return this.Transaction(() => {
            if (command.operation === 'queue-open') {
                if (command.confirmed !== true) throw new Error('Explicit confirmation is required');
                const control = this.Control();
                if (control.state === 'Running') throw new Error('Selective queue is already running');
                const preferences = this.ui.Validate(command.preferences);
                if (!preferences.rootId || preferences.reserveGiB !== this.ui.Preferences().reserveGiB) throw new Error('Choose a native folder and save reserve settings first');
                if (control.preferences && JSON.stringify(preferences) !== control.preferences) throw new Error('Selective queue destination and policy are frozen; budgets cannot be reset');
                let batchId = control.batch_id;
                if (!batchId || ['Drained', 'Cancelled'].includes(String(control.state))) {
                    batchId = randomUUID();
                    this.db.prepare('INSERT INTO hub_queue_batches(id,confirmed_at) VALUES(?,?)').run(batchId, Date.now());
                    this.db.prepare("INSERT INTO hub_queue_batch_members(batch_id,queue_seq,enqueue_version) SELECT ?,seq,enqueue_version FROM hub_queue WHERE removed=0 AND state IN ('Queued','Paused')").run(batchId);
                }
                this.db.prepare("UPDATE hub_queue_control SET state='Running',reason='',preferences=coalesce(preferences,?),current_seq=NULL,batch_id=? WHERE id=1").run(JSON.stringify(preferences), batchId);
                return this.Summary();
            }
            if (command.operation === 'queue-next') {
                const control = this.Control();
                if (control.state !== 'Running') throw new Error('Queue is not running');
                if (!control.batch_id) throw new Error('Confirmed run membership is unavailable; review required');
                if (control.current_seq) return this.Row(this.db.prepare('SELECT * FROM hub_queue WHERE seq=?').get(control.current_seq)!);
                const preferences = JSON.parse(String(control.preferences));
                const budget = this.Budget();
                // Already admitted tasks may reconcile their saved outputs at the cap. No new identities are admitted.
                const candidates = this.db.prepare("SELECT q.*,coalesce(r.mangas_used,0) admitted FROM hub_queue q JOIN hub_queue_batch_members m ON m.batch_id=? AND m.queue_seq=q.seq AND m.enqueue_version=q.enqueue_version LEFT JOIN archive_runs r ON r.session_id=q.session_id WHERE q.removed=0 AND q.state IN ('Queued','Paused') ORDER BY priority,q.seq").iterate(control.batch_id);
                let chosen: Record<string, any> | undefined;
                for (const row of candidates) { if (row.admitted || budget.mangasUsed < preferences.policy.maxMangas && budget.chaptersStarted < preferences.policy.maxChapters) { chosen = row; break; } }
                if (!chosen) {
                    const pending = this.db.prepare("SELECT 1 FROM hub_queue q JOIN hub_queue_batch_members m ON m.batch_id=? AND m.queue_seq=q.seq AND m.enqueue_version=q.enqueue_version WHERE q.removed=0 AND q.state IN ('Queued','Paused') LIMIT 1").get(control.batch_id);
                    this.db.prepare('UPDATE hub_queue_control SET state=?,reason=? WHERE id=1').run(pending ? 'Limited' : 'Drained', pending ? 'Cumulative development budget reached: 5 manga and 20 chapter attempts; remaining entries retained' : 'Confirmed run drained; later additions require another explicit Start; source completeness remains independent');
                    return null;
                }
                const sessionId = chosen.session_id ?? randomUUID();
                if (!chosen.session_id) {
                    this.db.prepare('INSERT INTO sessions(id,root_id,site_id,site_name,state,settings,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
                        .run(sessionId, preferences.rootId, chosen.site_id, chosen.site_name, 'paused', JSON.stringify({ format: preferences.format, useWebsiteSubDirectory: preferences.useWebsiteSubDirectory }), Date.now(), Date.now());
                    this.db.prepare("INSERT INTO archive_runs(session_id,state,policy,catalog_done,catalog_state,index_state,index_evidence) VALUES(?,'paused',?,1,'finished','unknown','Explicit personal selection; not a site catalog')").run(sessionId, JSON.stringify(preferences.policy));
                    this.db.prepare('INSERT INTO archive_mangas(session_id,id,title,position) VALUES(?,?,?,0)').run(sessionId, chosen.manga_id, chosen.title);
                }
                this.db.prepare("UPDATE hub_queue SET session_id=?,state='Preparing',reason='' WHERE seq=?").run(sessionId, chosen.seq);
                this.db.prepare('UPDATE hub_queue_control SET current_seq=? WHERE id=1').run(chosen.seq);
                return this.Row(this.db.prepare('SELECT * FROM hub_queue WHERE seq=?').get(chosen.seq)!);
            }
            if (command.operation === 'queue-result') {
                const control = this.Control();
                if (control.current_seq !== command.seq) throw new Error('Queue result belongs to another attempt');
                const row = this.db.prepare('SELECT * FROM hub_queue WHERE seq=?').get(command.seq)!;
                const snapshot = this.work.Snapshot(String(row.session_id));
                if (snapshot.state === 'running') throw new Error('Archive task has not ended');
                if (command.reason && ['paused', 'interrupted'].includes(snapshot.state)) this.db.prepare("UPDATE archive_runs SET state='review',reason=? WHERE session_id=?").run(ArchivePublicMessage(command.reason), row.session_id);
                const remaining = this.db.prepare("SELECT count(*) n FROM archive_work WHERE session_id=? AND state<>'healthy'").get(row.session_id)!.n;
                const total = this.db.prepare('SELECT count(*) n FROM archive_work WHERE session_id=?').get(row.session_id)!.n;
                const uncertain = this.db.prepare("SELECT count(*) n FROM session_chapters WHERE session_id=? AND (local_state<>'healthy' OR order_confidence='unknown')").get(row.session_id)!.n;
                const completed = !command.reason && total && !remaining && !uncertain && ['review', 'drained'].includes(snapshot.state);
                const state = command.reason ? 'Review' : completed ? 'Completed' : snapshot.state === 'cancelled' ? 'Cancelled' : snapshot.state === 'paused' || snapshot.state === 'interrupted' || snapshot.state === 'limited' ? 'Paused' : snapshot.state === 'failed' ? 'Failed' : 'Review';
                const detail = this.db.prepare("SELECT reason FROM archive_work WHERE session_id=? AND state IN ('review','failed') AND reason<>'' ORDER BY position LIMIT 1").get(row.session_id)
                    ?? this.db.prepare("SELECT reason FROM archive_mangas WHERE session_id=? AND state='review' AND reason<>'' LIMIT 1").get(row.session_id);
                this.db.prepare('UPDATE hub_queue SET state=?,reason=? WHERE seq=?').run(state, ArchivePublicMessage(command.reason ?? (completed ? 'Requested registered chapters verified; source completeness unproven' : detail?.reason ?? (snapshot.reason || 'Unknown chapter ordering, coverage or output requires review'))), command.seq);
                this.db.prepare('UPDATE hub_queue_control SET current_seq=NULL WHERE id=1').run();
                if (snapshot.state === 'limited' || snapshot.storageError) this.db.prepare('UPDATE hub_queue_control SET state=?,reason=? WHERE id=1').run(snapshot.storageError ? 'Paused' : 'Limited', ArchivePublicMessage(snapshot.reason));
                return;
            }
            if (command.operation === 'queue-stop') {
                if (!['Paused', 'Cancelled', 'Failed'].includes(command.state)) throw new Error('Invalid queue stop');
                const control = this.Control();
                if (control.state === 'Cancelled' && command.state === 'Failed') return;
                if (control.current_seq && this.db.prepare("SELECT 1 FROM archive_runs r JOIN hub_queue q ON q.session_id=r.session_id WHERE q.seq=? AND r.state='running'").get(control.current_seq)) throw new Error('Stop the owned archive manager before releasing queue ownership');
                if (control.current_seq) this.db.prepare("UPDATE hub_queue SET state=?,reason=? WHERE seq=? AND state IN ('Preparing','Downloading')").run(command.state, 'Stopped; files preserved and saved task identity retained', control.current_seq);
                this.db.prepare('UPDATE hub_queue_control SET state=?,reason=?,current_seq=NULL WHERE id=1').run(command.state, ArchivePublicMessage(Text(command.reason, 'stop reason'))); return;
            }
            if (command.operation === 'queue-select') {
                const ref = this.Reference(command.reference);
                if (typeof command.selected !== 'boolean') throw new Error('Invalid selection');
                if (command.selected) this.db.prepare('INSERT OR IGNORE INTO hub_selections(site_id,manga_id,title,site_name) VALUES(?,?,?,?)').run(ref.siteId, ref.mangaId, ref.title, ref.siteName);
                else this.db.prepare('DELETE FROM hub_selections WHERE site_id=? AND manga_id=?').run(ref.siteId, ref.mangaId);
                return;
            }
            if (command.operation === 'queue-add') {
                let added = 0, existing = 0;
                let priority = Number(this.db.prepare('SELECT coalesce(max(priority),0) n FROM hub_queue').get()!.n);
                const refs = command.reference ? [this.Reference(command.reference)] : this.db.prepare('SELECT site_id AS siteId,manga_id AS mangaId,title,site_name AS siteName FROM hub_selections ORDER BY seq').iterate();
                for (const input of refs) {
                    const ref = this.Reference(input as unknown as MangaReference);
                    const old = this.db.prepare('SELECT seq,removed FROM hub_queue WHERE site_id=? AND manga_id=?').get(ref.siteId, ref.mangaId);
                    if (old) {
                        if (old.removed) { this.db.prepare('UPDATE hub_queue SET removed=0,priority=?,enqueue_version=enqueue_version+1 WHERE seq=?').run(++priority, old.seq); added++; }
                        else existing++;
                    } else { this.db.prepare('INSERT INTO hub_queue(site_id,manga_id,title,site_name,priority) VALUES(?,?,?,?,?)').run(ref.siteId, ref.mangaId, ref.title, ref.siteName, ++priority); added++; }
                }
                return { added, existing };
            }
            if (command.operation === 'queue-edit') {
                const row = this.db.prepare('SELECT * FROM hub_queue WHERE seq=? AND removed=0').get(Count(command.seq, 'queue identity', Number.MAX_SAFE_INTEGER));
                const control = this.Control();
                const runningRemoval = command.action === 'remove' && !command.scope && row && row.seq !== control.current_seq
                    && !['Preparing', 'Downloading'].includes(String(row.state));
                if (!row || control.state === 'Running' && !runningRemoval) throw new Error('Pause the queue before editing its active task or ordering');
                if (command.scope) {
                    if (row.session_id) throw new Error('Scope is frozen after task preparation; existing receipts preserved');
                    this.db.prepare('UPDATE hub_queue SET scope=? WHERE seq=?').run(JSON.stringify(ValidateQueueScope(command.scope)), row.seq); return;
                }
                if (command.action === 'remove') this.db.prepare('UPDATE hub_queue SET removed=1 WHERE seq=?').run(row.seq);
                else {
                    if (!['up', 'down'].includes(command.action)) throw new Error('Invalid queue action');
                    const ascending = command.action === 'down';
                    const neighbor = this.db.prepare(`SELECT seq,priority FROM hub_queue WHERE removed=0 AND priority${ascending ? '>' : '<'}? ORDER BY priority ${ascending ? 'ASC' : 'DESC'} LIMIT 1`).get(row.priority);
                    if (neighbor) { this.db.prepare('UPDATE hub_queue SET priority=? WHERE seq=?').run(neighbor.priority, row.seq); this.db.prepare('UPDATE hub_queue SET priority=? WHERE seq=?').run(row.priority, neighbor.seq); }
                }
                return;
            }
            throw new Error('Unsupported selective queue command');
        });
    }
}
