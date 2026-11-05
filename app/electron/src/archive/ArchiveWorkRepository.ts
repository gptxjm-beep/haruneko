import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Count, Text, SafeMessage } from './ArchivePaths';
import { ArchiveDevelopmentLimits as Limits, type ArchiveCoordinatorCommand, type ArchivePolicy, type ArchiveRunSnapshot, type ArchiveEvidence } from './ArchiveCoordinatorProtocol';

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

    public Snapshot(sessionId: string): ArchiveRunSnapshot {
        const run = this.Run(sessionId);
        const counts: Record<string, number> = {};
        for (const row of this.database.prepare('SELECT state,count(*) AS n FROM archive_work WHERE session_id=? GROUP BY state').all(sessionId)) counts[String(row.state)] = Number(row.n);
        for (const row of this.database.prepare('SELECT state,count(*) AS n FROM archive_mangas WHERE session_id=? GROUP BY state').all(sessionId)) counts[`manga:${row.state}`] = Number(row.n);
        const due = this.database.prepare(`SELECT min(next_retry) AS due FROM archive_mangas WHERE session_id=? AND next_retry>0
            AND (state='ready' OR state='review' AND retryable=1 AND listings<?)`).get(sessionId, run.policy.maxAttempts)!.due;
        return { sessionId, state: run.state, policy: run.policy, catalogDone: !!run.catalog_done, catalogPages: run.catalog_pages,
            index: { state: run.index_state, evidence: run.index_evidence }, mangasUsed: run.mangas_used, chaptersStarted: run.chapters_started, reason: run.reason, catalogAttempts: run.catalog_attempts, counts, nextRetry: due === null ? null : Number(due) };
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
        if (command.operation === 'archive-events') return this.database.prepare('SELECT * FROM archive_events WHERE session_id=? AND id>? ORDER BY id LIMIT 100').all(sessionId, Count(command.after ?? 0, 'event cursor', Number.MAX_SAFE_INTEGER));
        if (command.operation === 'archive-run-state') {
            if (!['paused', 'cancelled', 'interrupted', 'limited', 'review', 'drained', 'failed'].includes(command.state)) throw new Error('Invalid run transition');
            return this.Transaction(() => {
                this.database.prepare('UPDATE archive_runs SET state=?,reason=? WHERE session_id=?').run(command.state, SafeMessage(command.reason), sessionId);
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
                if (run.catalog_done || run.catalog_attempts >= run.policy.maxAttempts) throw new Error('Catalog attempts exhausted');
                this.database.prepare('UPDATE archive_runs SET catalog_attempts=catalog_attempts+1 WHERE session_id=?').run(sessionId);
                return;
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
                    this.database.prepare('UPDATE archive_runs SET catalog_done=1,index_state=?,index_evidence=? WHERE session_id=?').run(evidence.state, evidence.evidence, sessionId);
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
            case 'archive-manga-list': {
                const manga = this.Manga(sessionId, command.mangaId);
                const evidence = Evidence(command.evidence);
                if (!Array.isArray(command.chapters) || !command.chapters.length || command.chapters.length > Limits.chaptersPerManga
                    || !['ascending', 'descending', 'unknown'].includes(command.order)) throw new Error('Invalid or oversized chapter manifest');
                const orderEvidence = command.orderEvidence ? Text(command.orderEvidence, 'order evidence') : '';
                if (command.order !== 'unknown' && !orderEvidence) throw new Error('Order requires evidence');
                return this.Transaction(() => {
                    const seen = new Map<string, { title: string; language: string | null }>();
                    for (const chapter of command.chapters) {
                        Text(chapter.id, 'chapter ID'); Text(chapter.title, 'chapter title', 4096); Count(chapter.position, 'position');
                        const language = chapter.language === null ? null : Text(chapter.language, 'language', 64);
                        const duplicate = seen.get(chapter.id);
                        if (duplicate) {
                            const conflict = duplicate.title !== chapter.title || duplicate.language !== language;
                            if (conflict) this.database.prepare("UPDATE archive_work SET state='review',reason='Conflicting metadata/languages share one chapter ID' WHERE session_id=? AND manga_id=? AND id=?").run(sessionId, manga.id, chapter.id);
                            this.Event(sessionId, conflict ? 'identity-conflict' : 'duplicate-chapter', conflict ? 'Conflicting metadata/languages share one chapter ID; connector maintenance required' : 'Stable identity occurs twice in chapter manifest', manga.id, chapter.id);
                            continue;
                        }
                        seen.set(chapter.id, { title: chapter.title, language });
                        const expected = chapter.expectedPages === undefined ? null : Count(chapter.expectedPages, 'expected pages');
                        if (chapter.expectedPagesTrusted !== undefined && typeof chapter.expectedPagesTrusted !== 'boolean') throw new Error('Invalid page count trust');
                        if (chapter.expectedPagesTrusted && (!expected || !chapter.expectedPagesEvidence)) throw new Error('Page count needs evidence');
                        if (chapter.expectedPagesEvidence !== undefined && (typeof chapter.expectedPagesEvidence !== 'string' || chapter.expectedPagesEvidence.length > 2048)) throw new Error('Invalid page count evidence');
                        const key = createHash('sha256').update(JSON.stringify([session.site_id, manga.id, chapter.id])).digest('hex');
                        const reason = command.order === 'unknown' ? 'unknown-order' : !language && run.policy.unknownLanguage === 'review' ? 'unknown-language'
                            : language && run.policy.languages.length && !run.policy.languages.includes(language) ? 'language-policy-exclusion' : '';
                        const state = reason === 'language-policy-exclusion' ? 'excluded' : reason ? 'review' : 'pending';
                        this.database.prepare('INSERT OR IGNORE INTO chapters(key,site_id,manga_id,chapter_id) VALUES(?,?,?,?)').run(key, session.site_id, manga.id, chapter.id);
                        this.database.prepare(`INSERT OR IGNORE INTO session_chapters(session_id,chapter_key,title,position,order_confidence,order_evidence,expected_pages,expected_trusted,pages_evidence)
                            VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, key, chapter.title, chapter.position, command.order === 'unknown' ? 'unknown' : 'connector-contract', orderEvidence, expected, chapter.expectedPagesTrusted ? 1 : 0, SafeMessage(chapter.expectedPagesEvidence ?? ''));
                        this.database.prepare(`INSERT OR IGNORE INTO archive_work(session_id,manga_id,id,chapter_key,title,position,language,expected_pages,expected_trusted,pages_evidence,state,reason)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId, manga.id, chapter.id, key, chapter.title, chapter.position, language, expected, chapter.expectedPagesTrusted ? 1 : 0, SafeMessage(chapter.expectedPagesEvidence ?? ''), state, reason);
                        if (reason || !language) this.Event(sessionId, reason || 'unknown-language-included', reason || 'Unknown language included by explicit policy', manga.id, chapter.id);
                    }
                    this.database.prepare("UPDATE archive_mangas SET listed=1,state='ready',evidence_state=?,evidence=?,reason='',next_retry=0,retryable=0 WHERE session_id=? AND id=?").run(evidence.state, evidence.evidence, sessionId, manga.id);
                    this.Event(sessionId, 'chapter-manifest', `${command.order}; ${evidence.state}: ${evidence.evidence}`, manga.id);
                });
            }
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
                this.Manga(sessionId, command.mangaId);
                return this.database.prepare(`SELECT * FROM archive_work WHERE session_id=? AND manga_id=? AND next_retry<=? AND checked_epoch<>?
                    AND (state='healthy' OR state='pending' AND attempts<?) ORDER BY position,id LIMIT 1`)
                    .get(sessionId, command.mangaId, Count(command.now, 'time', Number.MAX_SAFE_INTEGER), run.epoch, run.policy.maxAttempts) ?? null;
            case 'archive-chapter-begin': {
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
