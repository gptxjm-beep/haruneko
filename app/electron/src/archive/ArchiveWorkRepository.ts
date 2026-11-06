import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { Count, Text, SafeMessage } from './ArchivePaths';
import { ArchiveDevelopmentLimits as Limits, type ArchiveCoordinatorCommand, type ArchivePolicy, type ArchiveRunSnapshot, type ArchiveEvidence, type ArchiveWorkChapter } from './ArchiveCoordinatorProtocol';

type Row = Record<string, any>;

function Evidence(input: ArchiveEvidence): ArchiveEvidence {
    if (!input || !['complete', 'partial', 'unknown', 'unsupported'].includes(input.state) || typeof input.evidence !== 'string' || input.evidence.length > 2048) throw new Error('Invalid archive evidence');
    if (input.state === 'complete' && !input.evidence.trim()) throw new Error('Completeness needs explicit evidence');
    return { state: input.state, evidence: SafeMessage(input.evidence) };
}

export function ValidateArchivePolicy(input: ArchivePolicy): ArchivePolicy {
    if (!input || !Array.isArray(input.languages) || input.languages.length > 30 || !['include', 'review'].includes(input.unknownLanguage)) throw new Error('Invalid archive policy');
    const maxMangas = Count(input.maxMangas, 'manga limit', Limits.mangas);
    const maxChapters = Count(input.maxChapters, 'chapter limit', Limits.chapters);
    const delayMs = Count(input.delayMs, 'request delay', 60_000);
    const retryDelayMs = Count(input.retryDelayMs, 'retry delay', 60_000);
    const maxAttempts = Count(input.maxAttempts, 'attempt limit', 3);
    if (!maxMangas || !maxChapters || delayMs < 100 || retryDelayMs < 1000 || !maxAttempts) throw new Error('Unsafe development limits');
    return { maxMangas, maxChapters, delayMs, retryDelayMs, maxAttempts,
        languages: [...new Set(input.languages.map(language => Text(language, 'language', 64)))].sort(), unknownLanguage: input.unknownLanguage };
}

/** Durable coordinator queue. All compound transitions and diagnostic events commit together. */
export class ArchiveWorkRepository {
    constructor(private readonly database: DatabaseSync) {}

    private Transaction<T>(action: () => T): T {
        this.database.exec('BEGIN IMMEDIATE');
        try { const result = action(); this.database.exec('COMMIT'); return result; }
        catch(error) { this.database.exec('ROLLBACK'); throw error; }
    }

    private Run(sessionId: string): Row {
        const row = this.database.prepare('SELECT * FROM archive_runs WHERE session_id=?').get(Text(sessionId, 'session ID', 64));
        if (!row) throw new Error('Unknown archive run');
        return { ...row, policy: JSON.parse(String(row.policy)) };
    }

    private Manga(sessionId: string, mangaId: string): Row {
        const row = this.database.prepare('SELECT * FROM archive_mangas WHERE session_id=? AND id=?').get(sessionId, Text(mangaId, 'manga ID'));
        if (!row) throw new Error('Unknown archive manga');
        return row;
    }

    private Event(sessionId: string, kind: string, reason: string, mangaId?: string, chapterId?: string) {
        this.database.prepare('INSERT INTO archive_events(session_id,manga_id,chapter_id,kind,reason,created_at) VALUES(?,?,?,?,?,?)')
            .run(sessionId, mangaId ?? null, chapterId ?? null, kind, SafeMessage(reason), Date.now());
    }

    private InterruptCatalog(sessionId: string, reason: 'paused' | 'cancelled' | 'interrupted'): void {
        const run = this.Run(sessionId);
        if (!run.catalog_active || run.catalog_done) return;
        const coverage = run.catalog_pages ? 'partial' : 'unknown';
        const message = `Catalog ${reason} before a terminal commit; enumeration must resume`;
        this.database.prepare('UPDATE archive_runs SET catalog_active=0,catalog_state=?,catalog_attempts=max(0,catalog_attempts-1),index_state=?,index_evidence=? WHERE session_id=?')
            .run(reason, coverage, message, sessionId);
        this.database.prepare('UPDATE sessions SET index_state=? WHERE id=?').run(coverage, sessionId);
        this.Event(sessionId, 'catalog-interrupted', message);
    }

    /** Called inside the repository's startup transaction; an interrupted call is not a proven connector failure. */
    public RecoverInterruptedCatalogs(): void {
        for (const row of this.database.prepare('SELECT session_id FROM archive_runs WHERE catalog_active=1').all()) this.InterruptCatalog(String(row.session_id), 'interrupted');
    }

    public ManifestStorageEstimate(sessionId: string, mangaId: string): bigint {
        const row = this.database.prepare('SELECT expected_count FROM archive_manifests WHERE session_id=? AND manga_id=?').get(sessionId, mangaId);
        return BigInt(String(row?.expected_count ?? 0)) * 64n * 1024n;
    }

    private BeginManifest(sessionId: string, mangaId: string, count: number, order: string, orderEvidence: string, coverage: ArchiveEvidence): string {
        const manga = this.Manga(sessionId, mangaId);
        if (manga.listed || !['listing', 'registering'].includes(String(manga.state))) throw new Error('Manga is not awaiting a chapter manifest');
        Count(count, 'manifest length', Number.MAX_SAFE_INTEGER);
        if (!count || !['ascending', 'descending', 'unknown'].includes(order)) throw new Error('Invalid chapter manifest');
        const evidence = Evidence(coverage);
        if (order !== 'unknown') Text(orderEvidence, 'order evidence');
        else if (typeof orderEvidence !== 'string' || orderEvidence.length > 2048) throw new Error('Invalid order evidence');
        const token = randomUUID();
        this.database.prepare('DELETE FROM archive_manifest_entries WHERE session_id=? AND manga_id=?').run(sessionId, mangaId);
        this.database.prepare(`INSERT INTO archive_manifests(session_id,manga_id,token,expected_count,ordering,order_evidence,evidence)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,manga_id) DO UPDATE SET token=excluded.token,expected_count=excluded.expected_count,
            received_count=0,ordering=excluded.ordering,order_evidence=excluded.order_evidence,evidence=excluded.evidence,state='registering'`)
            .run(sessionId, mangaId, token, count, order, SafeMessage(orderEvidence), JSON.stringify(evidence));
        this.database.prepare("UPDATE archive_mangas SET state='registering',listed=0,reason='Chapter registration is incomplete' WHERE session_id=? AND id=?").run(sessionId, mangaId);
        this.Event(sessionId, 'manifest-begin', `${count} source entries; no chapter work is published yet`, mangaId);
        return token;
    }

    private Manifest(sessionId: string, mangaId: string, token: string): Row {
        const row = this.database.prepare('SELECT * FROM archive_manifests WHERE session_id=? AND manga_id=? AND token=?').get(sessionId, Text(mangaId, 'manga ID'), Text(token, 'manifest ID', 64));
        if (!row || row.state !== 'registering') throw new Error('Unknown or finished chapter registration');
        return row;
    }

    private AppendManifest(sessionId: string, mangaId: string, token: string, offset: number, chapters: ArchiveWorkChapter[]): void {
        const manifest = this.Manifest(sessionId, mangaId, token);
        Count(offset, 'batch offset', Number.MAX_SAFE_INTEGER);
        if (offset !== manifest.received_count || !Array.isArray(chapters) || !chapters.length || chapters.length > Limits.chapterBatchSize
            || offset + chapters.length > manifest.expected_count) throw new Error('Invalid or out-of-order chapter batch');
        for (let index = 0; index < chapters.length; index++) {
            const chapter = chapters[index];
            Text(chapter.id, 'chapter ID'); Text(chapter.title, 'chapter title', 4096);
            if (chapter.position !== offset + index) throw new Error('Chapter position differs from the committed batch order');
            if (chapter.language !== null) Text(chapter.language, 'language', 64);
            if (chapter.expectedPages !== undefined) Count(chapter.expectedPages, 'expected pages');
            if (chapter.expectedPagesTrusted !== undefined && typeof chapter.expectedPagesTrusted !== 'boolean') throw new Error('Invalid page count trust');
            if (chapter.expectedPagesTrusted && (!chapter.expectedPages || !chapter.expectedPagesEvidence)) throw new Error('Page count needs evidence');
            if (chapter.expectedPagesEvidence !== undefined && (typeof chapter.expectedPagesEvidence !== 'string' || chapter.expectedPagesEvidence.length > 2048)) throw new Error('Invalid page count evidence');
            const previous = this.database.prepare('SELECT payload FROM archive_manifest_entries WHERE session_id=? AND manga_id=? AND id=?').get(sessionId, mangaId, chapter.id);
            if (previous) {
                const prior = JSON.parse(String(previous.payload)) as ArchiveWorkChapter;
                const signature = (item: ArchiveWorkChapter) => JSON.stringify([item.title, item.language, item.expectedPages ?? null, !!item.expectedPagesTrusted, SafeMessage(item.expectedPagesEvidence ?? '')]);
                const conflict = signature(prior) !== signature(chapter);
                if (conflict) this.database.prepare('UPDATE archive_manifest_entries SET conflict=1 WHERE session_id=? AND manga_id=? AND id=?').run(sessionId, mangaId, chapter.id);
                this.Event(sessionId, conflict ? 'identity-conflict' : 'duplicate-chapter', conflict ? 'Conflicting metadata/languages share one chapter ID; connector maintenance required' : 'Stable identity occurs twice in chapter manifest', mangaId, chapter.id);
            } else {
                const payload = { id: chapter.id, title: chapter.title, position: chapter.position, language: chapter.language,
                    expectedPages: chapter.expectedPages, expectedPagesTrusted: !!chapter.expectedPagesTrusted, expectedPagesEvidence: SafeMessage(chapter.expectedPagesEvidence ?? '') };
                this.database.prepare('INSERT INTO archive_manifest_entries(session_id,manga_id,id,position,payload) VALUES(?,?,?,?,?)').run(sessionId, mangaId, chapter.id, chapter.position, JSON.stringify(payload));
            }
        }
        this.database.prepare('UPDATE archive_manifests SET received_count=received_count+? WHERE session_id=? AND manga_id=?').run(chapters.length, sessionId, mangaId);
        this.Event(sessionId, 'manifest-batch', `${offset + chapters.length}/${manifest.expected_count} source entries staged`, mangaId);
    }

    private PublishManifest(sessionId: string, mangaId: string, token: string, siteId: string, policy: ArchivePolicy): void {
        const manifest = this.Manifest(sessionId, mangaId, token);
        if (manifest.received_count !== manifest.expected_count) throw new Error('Chapter registration is incomplete');
        const evidence = JSON.parse(String(manifest.evidence)) as ArchiveEvidence;
        // Stream durable staging rows; do not materialize another complete manifest in main-process memory.
        for (const row of this.database.prepare('SELECT payload,conflict FROM archive_manifest_entries WHERE session_id=? AND manga_id=? ORDER BY position,id').iterate(sessionId, mangaId)) {
            const chapter = JSON.parse(String(row.payload)) as ArchiveWorkChapter;
            const key = createHash('sha256').update(JSON.stringify([siteId, mangaId, chapter.id])).digest('hex');
            const reason = row.conflict ? 'Conflicting metadata/languages share one chapter ID' : manifest.ordering === 'unknown' ? 'unknown-order'
                : !chapter.language && policy.unknownLanguage === 'review' ? 'unknown-language'
                    : chapter.language && policy.languages.length && !policy.languages.includes(chapter.language) ? 'language-policy-exclusion' : '';
            const state = reason === 'language-policy-exclusion' ? 'excluded' : reason ? 'review' : 'pending';
            this.database.prepare('INSERT OR IGNORE INTO chapters(key,site_id,manga_id,chapter_id) VALUES(?,?,?,?)').run(key, siteId, mangaId, chapter.id);
            this.database.prepare(`INSERT OR IGNORE INTO session_chapters(session_id,chapter_key,title,position,order_confidence,order_evidence,expected_pages,expected_trusted,pages_evidence)
                VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, key, chapter.title, chapter.position, manifest.ordering === 'unknown' ? 'unknown' : 'connector-contract', manifest.order_evidence, chapter.expectedPages ?? null, chapter.expectedPagesTrusted ? 1 : 0, chapter.expectedPagesEvidence ?? '');
            this.database.prepare(`INSERT OR IGNORE INTO archive_work(session_id,manga_id,id,chapter_key,title,position,language,expected_pages,expected_trusted,pages_evidence,state,reason)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId, mangaId, chapter.id, key, chapter.title, chapter.position, chapter.language, chapter.expectedPages ?? null, chapter.expectedPagesTrusted ? 1 : 0, chapter.expectedPagesEvidence ?? '', state, reason);
            if (row.conflict) this.database.prepare("UPDATE archive_work SET state='review',reason=? WHERE session_id=? AND manga_id=? AND id=?").run(reason, sessionId, mangaId, chapter.id);
            if (reason || !chapter.language) this.Event(sessionId, reason || 'unknown-language-included', reason || 'Unknown language included by explicit policy', mangaId, chapter.id);
        }
        this.database.prepare("UPDATE archive_mangas SET listed=1,state='ready',evidence_state=?,evidence=?,reason='',next_retry=0,retryable=0 WHERE session_id=? AND id=?").run(evidence.state, evidence.evidence, sessionId, mangaId);
        this.database.prepare("UPDATE archive_manifests SET state='complete' WHERE session_id=? AND manga_id=?").run(sessionId, mangaId);
        this.database.prepare('DELETE FROM archive_manifest_entries WHERE session_id=? AND manga_id=?').run(sessionId, mangaId);
        this.Event(sessionId, 'chapter-manifest', `${manifest.ordering}; ${evidence.state}: ${evidence.evidence}`, mangaId);
    }

    public Snapshot(sessionId: string): ArchiveRunSnapshot {
        const run = this.Run(sessionId);
        const counts: Record<string, number> = {};
        for (const row of this.database.prepare('SELECT state,count(*) AS n FROM archive_work WHERE session_id=? GROUP BY state').all(sessionId)) counts[String(row.state)] = Number(row.n);
        for (const row of this.database.prepare('SELECT state,count(*) AS n FROM archive_mangas WHERE session_id=? GROUP BY state').all(sessionId)) counts[`manga:${row.state}`] = Number(row.n);
        const due = this.database.prepare(`SELECT min(next_retry) AS due FROM archive_mangas WHERE session_id=? AND next_retry>0
            AND (state='ready' OR state='review' AND retryable=1 AND listings<?)`).get(sessionId, run.policy.maxAttempts)!.due;
        return { sessionId, state: run.state, policy: run.policy, catalogDone: !!run.catalog_done, catalogPages: run.catalog_pages,
            index: { state: run.index_state, evidence: run.index_evidence }, mangasUsed: run.mangas_used, chaptersStarted: run.chapters_started, reason: run.reason, catalogAttempts: run.catalog_attempts, catalogState: run.catalog_state, storageError: run.storage_error ? JSON.parse(String(run.storage_error)) : null, counts, nextRetry: due === null ? null : Number(due) };
    }

    public Execute(command: ArchiveCoordinatorCommand): unknown {
        const sessionId = Text(command.sessionId, 'session ID', 64);
        const session = this.database.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
        if (!session) throw new Error('Unknown archive session');
        if (command.operation === 'archive-run-open') {
            const policy = ValidateArchivePolicy(command.policy);
            const previous = this.database.prepare('SELECT * FROM archive_runs WHERE session_id=?').get(sessionId);
            if (session.state === 'closed' || previous && (previous.state === 'running' || previous.state === 'cancelled' || previous.policy !== JSON.stringify(policy))) throw new Error('Run is already active, cancelled, or policy differs');
            this.Transaction(() => {
                this.database.prepare(`INSERT INTO archive_runs(session_id,state,policy,epoch) VALUES(?,'running',?,1)
                    ON CONFLICT(session_id) DO UPDATE SET state='running',epoch=epoch+1,reason=''`).run(sessionId, JSON.stringify(policy));
                this.InterruptCatalog(sessionId, 'interrupted');
                if (previous?.storage_error) this.database.prepare("UPDATE attempts SET state='interrupted' WHERE session_id=? AND state='running'").run(sessionId);
                this.database.prepare("UPDATE archive_mangas SET state='pending',listings=max(0,listings-1),reason='Interrupted chapter registration must restart' WHERE session_id=? AND state='registering' AND listed=0").run(sessionId);
                this.database.prepare("UPDATE archive_mangas SET state='review',retryable=0,reason='Interrupted chapter listing exhausted its attempt budget' WHERE session_id=? AND state='listing' AND listings>=?").run(sessionId, policy.maxAttempts);
                this.database.prepare("UPDATE archive_mangas SET state='pending' WHERE session_id=? AND state='listing'").run(sessionId);
                this.database.prepare("UPDATE archive_mangas SET state='ready' WHERE session_id=? AND listed=1 AND state IN ('done','review') AND retryable=0").run(sessionId);
                this.database.prepare("UPDATE archive_work SET state='pending' WHERE session_id=? AND state='downloading'").run(sessionId);
                this.database.prepare("UPDATE sessions SET state='active',updated_at=? WHERE id=?").run(Date.now(), sessionId);
                this.Event(sessionId, 'run-start', 'Bounded development run; local and source completeness are independent');
            });
            return this.Snapshot(sessionId);
        }
        const run = this.Run(sessionId);
        if (command.operation === 'archive-run-snapshot') return this.Snapshot(sessionId);
        if (command.operation === 'archive-storage-stop') {
            const fault = command.fault;
            if (!fault || !['low-space', 'unmeasurable', 'disconnected', 'destination-changed', 'permission-denied', 'write-full', 'quota-exceeded'].includes(fault.code)) throw new Error('Invalid storage fault');
            Text(fault.location, 'storage location', 64);
            const data = JSON.stringify(fault);
            if (data.length > 2048) throw new Error('Storage fault is too large');
            return this.Transaction(() => {
                if (command.mangaId && command.chapterId) this.database.prepare("UPDATE archive_work SET state='pending',attempts=max(0,attempts-1),checked_epoch=0,reason='Storage stopped; reconcile output before retry' WHERE session_id=? AND manga_id=? AND id=? AND state='downloading'").run(sessionId, command.mangaId, command.chapterId);
                this.InterruptCatalog(sessionId, 'paused');
                this.database.prepare("UPDATE archive_runs SET storage_error=?,state='paused',reason=? WHERE session_id=?").run(data, `Storage ${fault.code} (${fault.location})`, sessionId);
                this.database.prepare("UPDATE sessions SET state='paused',updated_at=? WHERE id=?").run(Date.now(), sessionId);
                this.Event(sessionId, 'storage-stop', data, command.mangaId, command.chapterId);
            });
        }
        if (command.operation === 'archive-events') return this.database.prepare('SELECT * FROM archive_events WHERE session_id=? AND id>? ORDER BY id LIMIT 100').all(sessionId, Count(command.after ?? 0, 'event cursor', Number.MAX_SAFE_INTEGER));
        if (command.operation === 'archive-run-state') {
            if (!['paused', 'cancelled', 'interrupted', 'limited', 'review', 'drained', 'failed'].includes(command.state)) throw new Error('Invalid run transition');
            // A late renderer error cannot undo an explicit durable cancellation. Keep its diagnostic instead.
            if (run.state === 'cancelled' && command.state === 'failed') return this.Event(sessionId, 'late-error-after-cancel', command.reason);
            return this.Transaction(() => {
                this.database.prepare('UPDATE archive_runs SET state=?,reason=? WHERE session_id=?').run(command.state, SafeMessage(command.reason), sessionId);
                if (command.state !== 'paused') this.database.prepare('UPDATE archive_runs SET storage_error=NULL WHERE session_id=?').run(sessionId);
                this.database.prepare('UPDATE sessions SET state=?,updated_at=? WHERE id=?').run(command.state === 'cancelled' ? 'closed' : 'paused', Date.now(), sessionId);
                this.Event(sessionId, command.state, command.reason);
            });
        }
        if (run.state !== 'running') throw new Error('Archive run is not active');
        switch (command.operation) {
            case 'archive-note':
                if (command.kind !== 'catalog-retry') throw new Error('Invalid archive diagnostic kind');
                this.Event(sessionId, command.kind, Text(command.reason, 'diagnostic reason'));
                return;
            case 'archive-catalog-begin':
                if (run.catalog_active || run.catalog_done || run.catalog_attempts >= run.policy.maxAttempts) throw new Error('Catalog attempts exhausted or already active');
                return this.Transaction(() => {
                    this.database.prepare("UPDATE archive_runs SET catalog_attempts=catalog_attempts+1,catalog_active=1,catalog_state='fetching',index_state=CASE WHEN catalog_pages>0 THEN 'partial' ELSE 'unknown' END,index_evidence='Catalog enumeration is in progress' WHERE session_id=?").run(sessionId);
                    this.database.prepare("UPDATE sessions SET index_state=CASE WHEN ? THEN 'partial' ELSE 'unknown' END WHERE id=?").run(run.catalog_pages, sessionId);
                });
            case 'archive-catalog-interrupt':
                if (!['paused', 'cancelled'].includes(command.reason)) throw new Error('Invalid catalog interruption');
                return this.Transaction(() => this.InterruptCatalog(sessionId, command.reason));
            case 'archive-catalog-failed':
                return this.Transaction(() => {
                    if (!run.catalog_active) throw new Error('No active catalog attempt');
                    this.database.prepare("UPDATE archive_runs SET catalog_active=0,catalog_state='failed',index_state=CASE WHEN catalog_pages>0 THEN 'partial' ELSE 'unknown' END,index_evidence=? WHERE session_id=?").run(SafeMessage(command.reason), sessionId);
                    this.database.prepare("UPDATE sessions SET index_state=CASE WHEN ? THEN 'partial' ELSE 'unknown' END WHERE id=?").run(run.catalog_pages, sessionId);
                    this.Event(sessionId, 'catalog-failure', command.reason);
                });
            case 'archive-catalog-page': {
                if (run.catalog_done || run.catalog_pages >= Limits.catalogPages || !Array.isArray(command.items) || command.items.length > Limits.pageItems) throw new Error('Catalog development limit reached');
                return this.Transaction(() => {
                    let position = Number(this.database.prepare('SELECT count(*) AS n FROM archive_mangas WHERE session_id=?').get(sessionId)!.n);
                    for (const item of command.items) {
                        Text(item.id, 'manga ID'); Text(item.title, 'manga title', 4096);
                        const written = this.database.prepare('INSERT OR IGNORE INTO archive_mangas(session_id,id,title,position) VALUES(?,?,?,?)').run(sessionId, item.id, item.title, position++);
                        if (!written.changes) this.Event(sessionId, 'duplicate-manga', 'Stable identity already cataloged', item.id);
                    }
                    this.database.prepare('UPDATE archive_runs SET catalog_pages=catalog_pages+1 WHERE session_id=?').run(sessionId);
                    this.Event(sessionId, 'catalog-page', `${command.items.length} entries; page evidence is not site completeness`);
                });
            }
            case 'archive-catalog-end': {
                const evidence = Evidence(command.index);
                return this.Transaction(() => {
                    const count = this.database.prepare('SELECT count(*) AS n FROM archive_mangas WHERE session_id=?').get(sessionId)!.n;
                    if (!count && evidence.state === 'complete') { evidence.state = 'unknown'; evidence.evidence = 'Empty index requires review'; }
                    this.database.prepare("UPDATE archive_runs SET catalog_done=1,catalog_active=0,catalog_state='finished',index_state=?,index_evidence=? WHERE session_id=?").run(evidence.state, evidence.evidence, sessionId);
                    this.database.prepare('UPDATE sessions SET index_state=? WHERE id=?').run(evidence.state, sessionId);
                    this.Event(sessionId, 'catalog-end', `${evidence.state}: ${evidence.evidence}`);
                });
            }
            case 'archive-next-manga':
                return this.database.prepare(`SELECT * FROM archive_mangas WHERE session_id=? AND next_retry<=?
                    AND (state IN ('pending','ready') OR state='review' AND retryable=1 AND listings<?)
                    ORDER BY next_retry,position,id LIMIT 1`).get(sessionId, Count(command.now, 'time', Number.MAX_SAFE_INTEGER), run.policy.maxAttempts) ?? null;
            case 'archive-manga-begin': {
                const manga = this.Manga(sessionId, command.mangaId);
                if (!['pending', 'ready', 'review'].includes(String(manga.state))) throw new Error('Manga is already claimed or unavailable');
                if (!manga.admitted && run.mangas_used >= run.policy.maxMangas) throw new Error('Manga development limit reached');
                const needsListing = !manga.listed;
                if (needsListing && manga.listings >= run.policy.maxAttempts) throw new Error('Manga listing attempts exhausted');
                return this.Transaction(() => {
                    if (!manga.admitted) this.database.prepare('UPDATE archive_runs SET mangas_used=mangas_used+1 WHERE session_id=?').run(sessionId);
                    this.database.prepare('UPDATE archive_mangas SET admitted=1,state=?,listings=listings+? WHERE session_id=? AND id=?').run(needsListing ? 'listing' : 'ready', needsListing ? 1 : 0, sessionId, manga.id);
                    this.Event(sessionId, 'manga-begin', needsListing ? 'Fetch chapter manifest' : 'Resume saved manifest', manga.id);
                    return { needsListing };
                });
            }
            case 'archive-manifest-begin':
                return this.Transaction(() => this.BeginManifest(sessionId, command.mangaId, command.count, command.order, command.orderEvidence, command.evidence));
            case 'archive-manifest-batch':
                return this.Transaction(() => this.AppendManifest(sessionId, command.mangaId, command.manifestId, command.offset, command.chapters));
            case 'archive-manifest-end':
                return this.Transaction(() => this.PublishManifest(sessionId, command.mangaId, command.manifestId, String(session.site_id), run.policy));
            case 'archive-manga-list':
                // Compatibility for bounded one-shot callers. The coordinator uses the batched protocol.
                return this.Transaction(() => {
                    if (!Array.isArray(command.chapters) || command.chapters.length > Limits.chapterBatchSize) throw new Error('Use batched chapter registration');
                    const token = this.BeginManifest(sessionId, command.mangaId, command.chapters.length, command.order, command.orderEvidence, command.evidence);
                    this.AppendManifest(sessionId, command.mangaId, token, 0, command.chapters);
                    this.PublishManifest(sessionId, command.mangaId, token, String(session.site_id), run.policy);
                });
            case 'archive-manga-defer': {
                const manga = this.Manga(sessionId, command.mangaId);
                if (typeof command.retryable !== 'boolean') throw new Error('Invalid retry flag');
                return this.Transaction(() => {
                    this.database.prepare("UPDATE archive_mangas SET state='review',listed=0,reason=?,retryable=?,next_retry=? WHERE session_id=? AND id=?")
                        .run(SafeMessage(command.reason), command.retryable ? 1 : 0, Date.now() + run.policy.retryDelayMs, sessionId, manga.id);
                    this.Event(sessionId, 'manga-review', command.reason, manga.id);
                });
            }
            case 'archive-next-chapter':
                if (!this.Manga(sessionId, command.mangaId).listed) return null;
                return this.database.prepare(`SELECT * FROM archive_work WHERE session_id=? AND manga_id=? AND next_retry<=? AND checked_epoch<>?
                    AND (state='healthy' OR state='pending' AND attempts<?) ORDER BY position,id LIMIT 1`)
                    .get(sessionId, command.mangaId, Count(command.now, 'time', Number.MAX_SAFE_INTEGER), run.epoch, run.policy.maxAttempts) ?? null;
            case 'archive-chapter-begin': {
                if (!this.Manga(sessionId, command.mangaId).listed) throw new Error('Chapter registration has not committed');
                if (run.chapters_started >= run.policy.maxChapters) throw new Error('Chapter development limit reached');
                const row = this.database.prepare('SELECT * FROM archive_work WHERE session_id=? AND manga_id=? AND id=?').get(sessionId, Text(command.mangaId, 'manga ID'), Text(command.chapterId, 'chapter ID'));
                if (!row || Number(row.attempts) >= run.policy.maxAttempts || !['pending', 'healthy'].includes(String(row.state))) throw new Error('Chapter cannot start');
                return this.Transaction(() => {
                    this.database.prepare('UPDATE archive_runs SET chapters_started=chapters_started+1 WHERE session_id=?').run(sessionId);
                    this.database.prepare("UPDATE archive_work SET attempts=attempts+1,state='downloading' WHERE session_id=? AND manga_id=? AND id=?").run(sessionId, command.mangaId, command.chapterId);
                    this.Event(sessionId, 'chapter-begin', 'Owned attempt; manual downloads are independent', command.mangaId, command.chapterId);
                });
            }
            case 'archive-chapter-result': {
                if (!['healthy', 'review', 'failed', 'pending'].includes(command.state) || typeof command.retryable !== 'boolean') throw new Error('Invalid work result');
                const row = this.database.prepare('SELECT * FROM archive_work WHERE session_id=? AND manga_id=? AND id=?').get(sessionId, command.mangaId, command.chapterId);
                if (!row) throw new Error('Unknown work chapter');
                const retry = command.retryable && Number(row.attempts) < run.policy.maxAttempts;
                return this.Transaction(() => {
                    this.database.prepare('UPDATE archive_work SET state=?,checked_epoch=?,next_retry=?,reason=? WHERE session_id=? AND manga_id=? AND id=?')
                        .run(retry ? 'pending' : command.state, retry || command.state === 'pending' ? 0 : run.epoch, retry ? Date.now() + run.policy.retryDelayMs : 0, SafeMessage(command.reason), sessionId, command.mangaId, command.chapterId);
                    this.Event(sessionId, command.state, command.reason, command.mangaId, command.chapterId);
                });
            }
            case 'archive-manga-end': {
                const manga = this.Manga(sessionId, command.mangaId);
                if (!manga.listed) throw new Error('Chapter registration has not committed');
                const pending = this.database.prepare("SELECT min(next_retry) AS due FROM archive_work WHERE session_id=? AND manga_id=? AND state='pending' AND attempts<?").get(sessionId, manga.id, run.policy.maxAttempts);
                const review = this.database.prepare("SELECT id FROM archive_work WHERE session_id=? AND manga_id=? AND state IN ('review','failed') LIMIT 1").get(sessionId, manga.id);
                const state = pending?.due !== null && pending?.due !== undefined ? 'ready' : review || manga.evidence_state !== 'complete' ? 'review' : 'done';
                this.database.prepare('UPDATE archive_mangas SET state=?,next_retry=?,reason=? WHERE session_id=? AND id=?')
                    .run(state, state === 'ready' ? Number(pending!.due) : 0, state === 'review' ? 'Chapter failures, exclusions, or unproven chapter-list completeness' : '', sessionId, manga.id);
                return;
            }
        }
        throw new Error('Unsupported archive coordinator operation');
    }
}
