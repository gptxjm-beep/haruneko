import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Count, Text } from './ArchivePaths';
import { SelectiveBudget, AdmittedIdentity, LinkSelectiveSession } from './SelectiveHistory';
import { ArchivePublicMessage, type ArchiveUIRepository } from './ArchiveUIRepository';
import type { ArchiveWorkRepository } from './ArchiveWorkRepository';
import type { MangaReference, QueueManga, QueueScope, QueueSnapshot, SelectiveQueueCommand } from './SelectiveQueueContract';

export function ValidateQueueScope(scope: QueueScope): QueueScope {
    const extra: Pick<QueueScope, 'order' | 'direction' | 'sourceIds'> = {};
    if (scope?.order !== undefined) {
        if (!['source', 'first-last', 'last-first'].includes(scope.order)) throw new Error('Invalid chapter order');
        extra.order = scope.order;
    }
    if (scope?.direction !== undefined) {
        if (!['ascending', 'descending'].includes(scope.direction)) throw new Error('Invalid confirmed direction');
        extra.direction = scope.direction;
    }
    const ids = (values: string[]) => {
        if (!Array.isArray(values) || values.length > 100000) throw new Error('Invalid chapter identities');
        const result = values.map(id => Text(id, 'chapter identity'));
        if (new Set(result).size !== result.length) throw new Error('Conflicting or duplicate chapter identities need review');
        return result;
    };
    if (scope?.sourceIds) extra.sourceIds = ids(scope.sourceIds);
    if (scope?.mode === 'all' || scope?.mode === 'missing') return { mode: scope.mode, ...extra };
    if (scope?.mode === 'selected') return { mode: 'selected', ids: ids(scope.ids), ...extra };
    if (scope?.mode !== 'range') throw new Error('Unsupported chapter scope');
    const from = Count(scope.from, 'first oldest-first chapter', Number.MAX_SAFE_INTEGER), to = Count(scope.to, 'last oldest-first chapter', Number.MAX_SAFE_INTEGER);
    if (!from || to < from) throw new Error('Invalid chapter range');
    return { mode: 'range', from, to, ...extra };
}
/** SQLite is the sole authority for selections, queue order and task identity. No files are removed here. */
export class SelectiveQueueRepository {
    private audits = new Map<number, { healthy: number; missing: number; review: number; at: number }>();
    constructor(private readonly db: DatabaseSync, private readonly ui: ArchiveUIRepository, private readonly work: ArchiveWorkRepository) {}
    private Transaction<T>(action: () => T): T {
        if (this.db.isTransaction) return action();
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
            const counts = this.db.prepare("SELECT sum(w.state='healthy' AND sc.local_state='healthy') verified,sum(w.state='failed') failed,sum(w.state='review' OR (w.state='healthy' AND sc.local_state<>'healthy')) review,sum(w.state='pending') pending,sum(w.state<>'excluded') selected FROM archive_work w JOIN session_chapters sc ON sc.session_id=w.session_id AND sc.chapter_key=w.chapter_key WHERE w.session_id=?").get(row.session_id)!;
            Object.assign(progress, Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value ?? 0)])), { available: JSON.parse(String(row.scope ?? '{}'))._available });
        }
        if (row.session_id && state === 'Preparing') {
            const snapshot = this.work.Snapshot(String(row.session_id));
            if (snapshot.state === 'running' && snapshot.counts.downloading) state = 'Downloading';
        }
        return { seq: Number(row.seq), enqueueVersion: Number(row.enqueue_version ?? 1), siteId: String(row.site_id), mangaId: String(row.manga_id), title: String(row.title), siteName: String(row.site_name),
            historyCount: row.scope ? this.Sessions(Number(row.seq)).length : 0, existing: row.scope ? this.audits.get(Number(row.seq)) : undefined,
            state, reason: ArchivePublicMessage(row.reason), sessionId: row.session_id as string | null, scope: JSON.parse(String(row.scope ?? '{"mode":"all"}')), progress,
            detailsState: JSON.parse(String(row.scope ?? '{}'))._details?.state,
            inCurrentRun: !!this.db.prepare('SELECT 1 FROM hub_queue_batch_members m JOIN hub_queue_control c ON c.batch_id=m.batch_id WHERE m.queue_seq=? AND m.enqueue_version=?').get(row.seq, row.enqueue_version ?? 1) };
    }
    private Control() { return this.db.prepare('SELECT * FROM hub_queue_control WHERE id=1').get()!; }
    public Sessions(seq: number): string[] {
        const row = this.db.prepare('SELECT session_id FROM hub_queue WHERE seq=?').get(Count(seq, 'queue identity', Number.MAX_SAFE_INTEGER));
        if (!row) return [];
        return this.db.prepare("SELECT id FROM sessions WHERE id=? OR json_extract(settings,'$._queueSeq')=? ORDER BY (id=?) DESC,started_at DESC,id").all(row.session_id, seq, row.session_id).map(row => String(row.id));
    }
    public AuditRows(seq: number): Record<string, any>[] {
        if (this.Control().state === 'Running') throw new Error('Pause before checking saved files');
        const seen = new Set<string>(), result = [];
        for (const id of this.Sessions(seq)) for (const row of this.db.prepare('SELECT sc.session_id,sc.chapter_key,c.chapter_id id FROM session_chapters sc JOIN chapters c ON c.key=sc.chapter_key WHERE session_id=?').all(id)) {
            if (!seen.has(String(row.chapter_key))) { seen.add(String(row.chapter_key)); result.push(row); }
        }
        return result;
    }
    public AuditResult(seq: number, rows: { sessionId: string; key: string; state: string }[]): void {
        const counts = { healthy: 0, missing: 0, review: 0, at: Date.now() };
        for (const row of rows) {
            if (row.state === 'healthy') counts.healthy++; else if (['missing', 'not-written'].includes(row.state)) counts.missing++; else counts.review++;
            if (row.state === 'uncertain') this.db.prepare("UPDATE session_chapters SET local_state='uncertain' WHERE session_id=? AND chapter_key=?").run(row.sessionId, row.key);
        }
        this.audits.set(seq, counts);
        if (counts.missing || counts.review) this.db.prepare("UPDATE hub_queue SET state='Review',reason='Previously saved files are missing or need review; inspect chapters before retry' WHERE seq=? AND state='Completed'").run(seq);
    }
    public Report(seq: number) {
        const entry = this.db.prepare('SELECT * FROM hub_queue WHERE seq=?').get(Count(seq, 'queue identity', Number.MAX_SAFE_INTEGER));
        if (!entry) throw new Error('Unknown queue identity');
        return { schema: 1, title: entry.title, site: entry.site_name, generatedAt: new Date().toISOString(), budget: this.Budget(), sourceCompleteness: 'unproven', sessions: this.Sessions(seq).map(id => {
            const counts = this.db.prepare("SELECT count(*) registered,sum(w.state<>'excluded') requested,sum(w.state='healthy' AND sc.local_state='healthy') completed,sum(w.state='failed') failed,sum(w.state='review' OR (w.state='healthy' AND sc.local_state<>'healthy')) review,sum(w.state='pending') pending FROM archive_work w JOIN session_chapters sc ON sc.session_id=w.session_id AND sc.chapter_key=w.chapter_key WHERE w.session_id=?").get(id)!;
            const run = this.db.prepare('SELECT state,reason FROM archive_runs WHERE session_id=?').get(id);
            const chapters = this.db.prepare("SELECT w.id,w.title,w.state,sc.local_state localState,w.reason,w.chapter_key FROM archive_work w JOIN session_chapters sc ON sc.session_id=w.session_id AND sc.chapter_key=w.chapter_key WHERE w.session_id=? ORDER BY w.position,w.id LIMIT 1000").all(id).map(chapter => ({ id: chapter.id, title: chapter.title, state: chapter.state, localState: chapter.localState, reason: ArchivePublicMessage(chapter.reason), attempts: this.db.prepare('SELECT state,stage,result,updated_at FROM attempts WHERE session_id=? AND chapter_key=? ORDER BY started_at DESC LIMIT 10').all(id, chapter.chapter_key).map(attempt => ({ state: attempt.state, stage: attempt.stage, updatedAt: attempt.updated_at, result: attempt.result ? JSON.parse(String(attempt.result)) : null })), errors: this.db.prepare('SELECT e.stage,e.message FROM errors e JOIN attempts a ON a.id=e.attempt_id WHERE a.session_id=? AND a.chapter_key=? ORDER BY e.id DESC LIMIT 10').all(id, chapter.chapter_key).map(error => ({ stage: error.stage, message: ArchivePublicMessage(error.message) })) }));
            const history = this.db.prepare("SELECT reason,created_at FROM archive_events WHERE session_id=? AND kind='download-report' ORDER BY created_at DESC LIMIT 10").all(id).map(row => JSON.parse(String(row.reason)));
            return { id, state: run?.state, reason: ArchivePublicMessage(run?.reason), counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value ?? 0)])), chapters, truncated: Number(counts.registered) > 1000, history };
        }), details: JSON.parse(String(entry.scope))._details?.state ?? 'Unavailable' };
    }
    private CaptureReport(seq: number, sessionId: unknown): void {
        if (typeof sessionId !== 'string') return;
        const report = this.Report(seq), session = report.sessions.find(session => session.id === sessionId);
        if (!session) return; session.history = [];
        this.db.prepare("INSERT INTO archive_events(session_id,manga_id,kind,reason,created_at) VALUES(?,'','download-report',?,?)").run(sessionId, JSON.stringify({ ...report, sessions: [session] }), Date.now());
    }
    public Details(seq: number): Record<string, any> {
        const row = this.db.prepare('SELECT * FROM hub_queue WHERE seq=? AND removed=0').get(Count(seq, 'queue identity', Number.MAX_SAFE_INTEGER));
        if (!row?.session_id) throw new Error('Prepare this queue item before saving details');
        return row;
    }
    public SaveDetails(seq: number, details: unknown): void {
        const row = this.Details(seq), scope = JSON.parse(String(row.scope));
        this.db.prepare('UPDATE hub_queue SET scope=? WHERE seq=?').run(JSON.stringify({ ...scope, _details: details }), seq);
    }
    public MetadataEntry(seq: number): Record<string, any> {
        const row = this.db.prepare('SELECT * FROM hub_queue WHERE seq=?').get(Count(seq, 'queue identity', Number.MAX_SAFE_INTEGER));
        const id = row?.session_id ?? this.Sessions(seq)[0];
        if (!row || !id) throw new Error('No saved metadata session');
        return { ...row, session_id: id };
    }
    public Budget(): { mangasUsed: number; chaptersStarted: number } {
        return SelectiveBudget(this.db);
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
        if (command.operation === 'queue-report') return this.Report(command.seq);
        if (command.operation === 'queue-chapters') {
            const row = this.db.prepare('SELECT session_id FROM hub_queue WHERE seq=? AND removed=0').get(Count(command.seq, 'queue identity', Number.MAX_SAFE_INTEGER));
            if (!row) throw new Error('Unknown queue item');
            return row.session_id ? this.db.prepare('SELECT w.id,w.title,w.language,w.state,w.reason,w.position,sc.local_state AS localState FROM archive_work w LEFT JOIN session_chapters sc ON sc.session_id=w.session_id AND sc.chapter_key=w.chapter_key WHERE w.session_id=? ORDER BY w.position,w.id LIMIT 200 OFFSET ?').all(row.session_id, Count(command.offset ?? 0, 'chapter offset', Number.MAX_SAFE_INTEGER)) : [];
        }
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
            if (command.operation === 'queue-observation') {
                const row = this.db.prepare('SELECT * FROM hub_queue WHERE seq=? AND removed=0').get(Count(command.seq, 'queue identity', Number.MAX_SAFE_INTEGER));
                if (!row) throw new Error('Unknown queue item');
                const scope = JSON.parse(String(row.scope));
                this.db.prepare('UPDATE hub_queue SET scope=? WHERE seq=?').run(JSON.stringify({ ...scope, _available: Count(command.available, 'observed chapters', 1000000) }), row.seq); return;
            }
            if (command.operation === 'queue-supplement') {
                if (command.confirmed !== true || this.Control().state === 'Running') throw new Error('Pause and explicitly confirm a supplementary selection');
                const row = this.Details(command.seq), scope = ValidateQueueScope(command.scope);
                this.CaptureReport(Number(row.seq), row.session_id);
                LinkSelectiveSession(this.db, Number(row.seq), row.session_id);
                this.db.prepare("UPDATE hub_queue SET session_id=NULL,state='Queued',reason='Supplementary selection confirmed; previous manifest retained',enqueue_version=enqueue_version+1,scope=? WHERE seq=?").run(JSON.stringify({ ...scope, _details: JSON.parse(String(row.scope))._details }), row.seq);
                this.db.exec("UPDATE hub_queue_control SET state='Paused',batch_id=NULL,current_seq=NULL WHERE id=1");
                return;
            }
            if (command.operation === 'queue-details-unavailable') {
                const row = this.Details(command.seq), previous = JSON.parse(String(row.scope))._details;
                this.SaveDetails(command.seq, { state: previous?.files?.length ? 'Partial' : 'Unavailable', files: previous?.files ?? [] }); return;
            }
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
                for (const row of candidates) {
                    const scope = JSON.parse(String(row.scope));
                    if (scope.mode === 'selected' && scope.ids.length === 0) continue;
                    if (row.admitted || AdmittedIdentity(this.db, Number(row.seq)) || budget.mangasUsed < preferences.policy.maxMangas && budget.chaptersStarted < preferences.policy.maxChapters) { chosen = row; break; }
                }
                if (!chosen) {
                    const pending = this.db.prepare("SELECT 1 FROM hub_queue q JOIN hub_queue_batch_members m ON m.batch_id=? AND m.queue_seq=q.seq AND m.enqueue_version=q.enqueue_version WHERE q.removed=0 AND q.state IN ('Queued','Paused') AND NOT (json_extract(q.scope,'$.mode')='selected' AND json_array_length(q.scope,'$.ids')=0) LIMIT 1").get(control.batch_id);
                    this.db.prepare('UPDATE hub_queue_control SET state=?,reason=? WHERE id=1').run(pending ? 'Limited' : 'Drained', pending ? 'Cumulative development budget reached: 5 manga and 20 chapter attempts; remaining entries retained' : 'Confirmed run drained; zero-selection entries did not start. Later additions require another explicit Start; source completeness remains independent');
                    return null;
                }
                const sessionId = chosen.session_id ?? randomUUID();
                if (!chosen.session_id) {
                    this.db.prepare('INSERT INTO sessions(id,root_id,site_id,site_name,state,settings,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
                        .run(sessionId, preferences.rootId, chosen.site_id, chosen.site_name, 'paused', JSON.stringify({ format: preferences.format, useWebsiteSubDirectory: preferences.useWebsiteSubDirectory }), Date.now(), Date.now());
                    this.db.prepare("INSERT INTO archive_runs(session_id,state,policy,catalog_done,catalog_state,index_state,index_evidence) VALUES(?,'paused',?,1,'finished','unknown','Explicit personal selection; not a site catalog')").run(sessionId, JSON.stringify(preferences.policy));
                    this.db.prepare('INSERT INTO archive_mangas(session_id,id,title,position) VALUES(?,?,?,0)').run(sessionId, chosen.manga_id, chosen.title);
                    LinkSelectiveSession(this.db, Number(chosen.seq), sessionId);
                    if (AdmittedIdentity(this.db, Number(chosen.seq))) this.db.prepare('UPDATE archive_mangas SET admitted=1 WHERE session_id=?').run(sessionId);
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
                const remaining = this.db.prepare("SELECT count(*) n FROM archive_work WHERE session_id=? AND state NOT IN ('healthy','excluded')").get(row.session_id)!.n;
                const total = this.db.prepare('SELECT count(*) n FROM archive_work WHERE session_id=?').get(row.session_id)!.n;
                const uncertain = this.db.prepare("SELECT count(*) n FROM session_chapters sc JOIN archive_work w ON w.session_id=sc.session_id AND w.chapter_key=sc.chapter_key WHERE sc.session_id=? AND w.state<>'excluded' AND (sc.local_state<>'healthy' OR sc.order_confidence='unknown')").get(row.session_id)!.n;
                const completed = !command.reason && total && !remaining && !uncertain && ['review', 'drained'].includes(snapshot.state);
                const state = command.reason ? 'Review' : completed ? 'Completed' : snapshot.state === 'cancelled' ? 'Cancelled' : snapshot.state === 'paused' || snapshot.state === 'interrupted' || snapshot.state === 'limited' ? 'Paused' : snapshot.state === 'failed' ? 'Failed' : 'Review';
                const detail = this.db.prepare("SELECT reason FROM archive_work WHERE session_id=? AND state IN ('review','failed') AND reason<>'' ORDER BY position LIMIT 1").get(row.session_id)
                    ?? this.db.prepare("SELECT reason FROM archive_mangas WHERE session_id=? AND state='review' AND reason<>'' LIMIT 1").get(row.session_id);
                this.db.prepare('UPDATE hub_queue SET state=?,reason=? WHERE seq=?').run(state, ArchivePublicMessage(command.reason ?? (completed ? 'Requested registered chapters verified; source completeness unproven' : detail?.reason ?? (snapshot.reason || 'Unknown chapter ordering, coverage or output requires review'))), command.seq);
                this.db.prepare('UPDATE hub_queue_control SET current_seq=NULL WHERE id=1').run();
                this.CaptureReport(Number(command.seq), row.session_id);
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
                else {
                    if (this.db.prepare('SELECT 1 FROM hub_selection_scopes c JOIN hub_selections s ON s.seq=c.selection_seq WHERE s.site_id=? AND s.manga_id=?').get(ref.siteId, ref.mangaId)) throw new Error('This cart item has chapter customizations. Confirm removal in Selection Cart');
                    this.db.prepare('DELETE FROM hub_selections WHERE site_id=? AND manga_id=?').run(ref.siteId, ref.mangaId);
                }
                return;
            }
            if (command.operation === 'queue-add') {
                let added = 0, existing = 0;
                let priority = Number(this.db.prepare('SELECT coalesce(max(priority),0) n FROM hub_queue').get()!.n);
                const refs = command.reference ? [this.Reference(command.reference)] : this.db.prepare('SELECT site_id AS siteId,manga_id AS mangaId,title,site_name AS siteName FROM hub_selections ORDER BY seq').iterate();
                for (const input of refs) {
                    const ref = this.Reference(input as unknown as MangaReference);
                    const old = this.db.prepare('SELECT seq,removed,session_id FROM hub_queue WHERE site_id=? AND manga_id=?').get(ref.siteId, ref.mangaId);
                    if (old) {
                        if (old.removed) {
                            this.CaptureReport(Number(old.seq), old.session_id);
                            LinkSelectiveSession(this.db, Number(old.seq), old.session_id);
                            const previous = this.db.prepare('SELECT scope FROM hub_queue WHERE seq=?').get(old.seq)!;
                            this.db.prepare("UPDATE hub_queue SET removed=0,priority=?,enqueue_version=enqueue_version+1,session_id=NULL,state='Queued',reason='New selection; historical files, reports and cumulative budget retained',scope=? WHERE seq=?").run(++priority, JSON.stringify({ mode: 'all', order: 'source', _details: JSON.parse(String(previous.scope))._details }), old.seq); added++;
                            if (this.Control().state !== 'Running') this.db.exec("UPDATE hub_queue_control SET state='Paused',batch_id=NULL,current_seq=NULL WHERE id=1");
                        }
                        else existing++;
                    } else { this.db.prepare('INSERT INTO hub_queue(site_id,manga_id,title,site_name,priority,scope) VALUES(?,?,?,?,?,?)').run(ref.siteId, ref.mangaId, ref.title, ref.siteName, ++priority, JSON.stringify({ mode: 'all', order: 'source' })); added++; }
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
                    const scope = ValidateQueueScope(command.scope);
                    if (row.session_id) {
                        if (!scope.order || !scope.sourceIds) throw new Error('Load the saved chapter list and explicitly choose its execution order first');
                        const work = this.db.prepare('SELECT id,chapter_key,state,reason,position,language FROM archive_work WHERE session_id=? ORDER BY position,id').all(row.session_id);
                        const policy = JSON.parse(String(this.db.prepare('SELECT policy FROM archive_runs WHERE session_id=?').get(row.session_id)!.policy));
                        const available = new Set(work.map(chapter => String(chapter.id)));
                        const sourceIds = new Set(scope.sourceIds);
                        if (!work.length || work.some(chapter => !sourceIds.has(String(chapter.id)))) throw new Error('Saved manifest cannot be expanded or lose chapter identities');
                        if (scope.mode !== 'selected' && scope.sourceIds.some(id => !available.has(id))) throw new Error('Saved manifest cannot expand to previously unregistered chapters');
                        if (scope.mode === 'selected' && scope.ids.some(id => !available.has(id))) throw new Error('Saved manifest does not contain a selected chapter; review required');
                        if ((scope.mode === 'range' || scope.order !== 'source') && !scope.direction) throw new Error('Confirm the saved source direction before chronological ordering or a numeric range');
                        let ordered = scope.sourceIds.filter(id => available.has(id));
                        if (scope.order === 'first-last' && scope.direction === 'descending' || scope.order === 'last-first' && scope.direction === 'ascending') ordered = ordered.toReversed();
                        let selected = new Set(ordered);
                        if (scope.mode === 'selected') selected = new Set(scope.ids);
                        if (scope.mode === 'range') {
                            const chronological = scope.direction === 'descending' ? scope.sourceIds.toReversed() : scope.sourceIds;
                            if (scope.to > chronological.length) throw new Error('Invalid saved range');
                            selected = new Set(chronological.slice(scope.from - 1, scope.to));
                        }
                        const positions = new Map(ordered.map((id, position) => [id, position]));
                        for (const chapter of work) {
                            const position = positions.get(String(chapter.id))!;
                            this.db.prepare('UPDATE archive_work SET position=? WHERE session_id=? AND id=?').run(position, row.session_id, chapter.id);
                            this.db.prepare('UPDATE session_chapters SET position=? WHERE session_id=? AND chapter_key=?').run(position, row.session_id, chapter.chapter_key);
                            const editable = chapter.reason === 'unknown-order' || chapter.reason === 'user-selection-exclusion' || chapter.state === 'pending';
                            if (chapter.state === 'healthy' && !selected.has(String(chapter.id))) {
                                // Execution exclusion is independent of the preserved local file receipt.
                                this.db.prepare("UPDATE archive_work SET state='excluded',reason='user-selection-exclusion' WHERE session_id=? AND id=?").run(row.session_id, chapter.id);
                            }
                            if (editable) {
                                const languageReason = !chapter.language && policy.unknownLanguage === 'review' ? 'unknown-language' : chapter.language && policy.languages.length && !policy.languages.includes(chapter.language) ? 'language-policy-exclusion' : '';
                                const reason = languageReason || (selected.has(String(chapter.id)) ? '' : 'user-selection-exclusion');
                                this.db.prepare('UPDATE archive_work SET state=?,reason=? WHERE session_id=? AND id=?').run(reason === 'unknown-language' ? 'review' : reason ? 'excluded' : 'pending', reason, row.session_id, chapter.id);
                                this.db.prepare("UPDATE session_chapters SET order_confidence='user-confirmed',order_evidence=? WHERE session_id=? AND chapter_key=?").run(`User selected execution sequence ${scope.order}; chronology ${scope.direction ?? 'unproven'}`, row.session_id, chapter.chapter_key);
                            }
                        }
                        this.db.prepare("UPDATE archive_mangas SET state='ready' WHERE session_id=? AND listed=1").run(row.session_id);
                        this.db.prepare("UPDATE hub_queue SET state='Paused',reason='Execution policy changed explicitly; files and attempt budgets preserved' WHERE seq=?").run(row.seq);
                    }
                    const before = JSON.parse(String(row.scope));
                    this.db.prepare('UPDATE hub_queue SET scope=? WHERE seq=?').run(JSON.stringify({ ...scope, _details: before._details, _available: before._available }), row.seq); return;
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
