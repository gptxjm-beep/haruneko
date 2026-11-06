import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Count, Text } from './ArchivePaths';
import { ArchiveFormats, DefaultArchivePreferences, type ArchivePreferences, type ArchiveUIProgress, type ArchiveUISession } from './ArchiveUIContract';
import { ValidateArchivePolicy, type ArchiveWorkRepository } from './ArchiveWorkRepository';

/** Display diagnostics deliberately omit URLs, native paths and arbitrary connector messages. Full stage/category remains available. */
export function ArchivePublicMessage(value: unknown): string {
    return String(value ?? '').slice(0, 2048)
        .replace(/https?:\/\/\S+/gi, '[source]')
        .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*/g, '[path]')
        .replace(/\b(authorization|cookie|set-cookie|token|password|secret)\s*[:=].*/gi, '$1=[redacted]');
}

export class ArchiveUIRepository {
    constructor(private readonly db: DatabaseSync, private readonly work: ArchiveWorkRepository) {}

    public Validate(input: ArchivePreferences): ArchivePreferences {
        if (!input || !Object.values(ArchiveFormats).some(format => format === input.format) || typeof input.useWebsiteSubDirectory !== 'boolean') throw new Error('Invalid archive preferences');
        if (input.rootId !== null && !this.db.prepare('SELECT id FROM roots WHERE id=?').get(Text(input.rootId, 'root ID', 64))) throw new Error('Select an archive folder with the native picker');
        const reserveGiB = Count(input.reserveGiB, 'free-space reserve', 4096);
        if (reserveGiB < 50) throw new Error('Archive reserve must be at least 50 GiB');
        return { rootId: input.rootId, format: input.format, useWebsiteSubDirectory: input.useWebsiteSubDirectory, reserveGiB, policy: ValidateArchivePolicy(input.policy) };
    }

    public Preferences(): ArchivePreferences {
        const row = this.db.prepare('SELECT value FROM archive_ui_preferences WHERE id=1').get();
        return this.Validate(row ? JSON.parse(String(row.value)) : structuredClone(DefaultArchivePreferences));
    }

    public RootLabel(rootId: string | null): string {
        return rootId ? String(this.db.prepare('SELECT label FROM roots WHERE id=?').get(rootId)?.label ?? 'Unavailable folder') : 'No folder selected';
    }

    public Save(input: ArchivePreferences): ArchivePreferences {
        const value = this.Validate(input);
        if (value.reserveGiB !== this.Preferences().reserveGiB
            && (this.db.prepare("SELECT 1 FROM archive_runs WHERE state IN ('running','paused','interrupted') LIMIT 1").get()
                || this.db.prepare("SELECT 1 FROM hub_queue_control WHERE state='Running'").get())) throw new Error('Stop or cancel open archive sessions and the selective queue before changing the storage reserve');
        this.db.prepare('INSERT INTO archive_ui_preferences(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
        return value;
    }

    public Create(siteId: string, siteName: string, preferences: ArchivePreferences, confirmed: boolean): string {
        if (confirmed !== true) throw new Error('Explicit confirmation is required');
        const value = this.Validate(preferences);
        if (!value.rootId) throw new Error('Select an archive folder first');
        // Reserve is process-wide. A session cannot lower it or silently alter other sessions.
        if (value.reserveGiB !== this.Preferences().reserveGiB) throw new Error('Save the reserve in Archiving settings before creating a session');
        Text(siteId, 'site ID'); Text(siteName, 'site name');
        const id = randomUUID();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('INSERT INTO sessions(id,root_id,site_id,site_name,state,settings,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
                .run(id, value.rootId, siteId, siteName, 'paused', JSON.stringify({ format: value.format, useWebsiteSubDirectory: value.useWebsiteSubDirectory }), Date.now(), Date.now());
            this.db.prepare("INSERT INTO archive_runs(session_id,state,policy,reason) VALUES(?,'paused',?,'Prepared; awaiting Start')").run(id, JSON.stringify(value.policy));
            this.db.exec('COMMIT');
        } catch(error) { this.db.exec('ROLLBACK'); throw error; }
        return id;
    }

    public Session(id: string): ArchiveUISession {
        const row = this.db.prepare('SELECT s.*,s.rowid AS cursor,r.label FROM sessions s JOIN roots r ON r.id=s.root_id WHERE s.id=?').get(Text(id, 'session ID', 64));
        if (!row) throw new Error('Unknown archive session');
        const snapshot = this.work.Snapshot(id);
        return { id, cursor: Number(row.cursor), siteId: String(row.site_id), siteName: ArchivePublicMessage(row.site_name), rootLabel: String(row.label), createdAt: Number(row.started_at), format: JSON.parse(String(row.settings)).format,
            snapshot: { ...snapshot, reason: ArchivePublicMessage(snapshot.reason), index: { ...snapshot.index, evidence: ArchivePublicMessage(snapshot.index.evidence) } } };
    }

    public Sessions(before = Number.MAX_SAFE_INTEGER): ArchiveUISession[] {
        return this.db.prepare('SELECT r.session_id FROM archive_runs r JOIN sessions s ON s.id=r.session_id WHERE s.rowid<? AND NOT EXISTS (SELECT 1 FROM hub_queue q WHERE q.session_id=s.id) ORDER BY s.rowid DESC LIMIT 50')
            .all(Count(before, 'session cursor', Number.MAX_SAFE_INTEGER)).map(row => this.Session(String(row.session_id)));
    }

    public Progress(id: string): ArchiveUIProgress {
        const session = this.Session(id);
        const chapter = this.db.prepare("SELECT title,manga_id FROM archive_work WHERE session_id=? AND state='downloading' ORDER BY position LIMIT 1").get(id);
        const manga = chapter ? this.db.prepare('SELECT title FROM archive_mangas WHERE session_id=? AND id=?').get(id, chapter.manga_id)
            : session.snapshot.state === 'running' ? this.db.prepare("SELECT title FROM archive_mangas WHERE session_id=? AND state IN ('listing','registering','ready') ORDER BY CASE WHEN state='ready' THEN 1 ELSE 0 END,next_retry,position LIMIT 1").get(id) : null;
        const n = (sql: string) => Number(this.db.prepare(sql).get(id)!.n);
        return { ...session, currentManga: manga ? ArchivePublicMessage(manga.title) : null, currentChapter: chapter ? ArchivePublicMessage(chapter.title) : null,
            discoveredMangas: n('SELECT count(*) n FROM archive_mangas WHERE session_id=?'), registeredChapters: n('SELECT count(*) n FROM archive_work WHERE session_id=?'),
            verifiedChapters: n("SELECT count(*) n FROM archive_work WHERE session_id=? AND state='healthy'"),
            writtenBytes: n("SELECT coalesce(sum(size),0) n FROM files WHERE state='verified' AND id IN (SELECT af.file_id FROM attempt_files af JOIN attempts a ON a.id=af.attempt_id WHERE a.session_id=?)"),
            events: this.db.prepare('SELECT id,kind,reason,created_at FROM archive_events WHERE session_id=? ORDER BY id DESC LIMIT 100').all(id)
                .map(row => ({ id: Number(row.id), kind: String(row.kind), reason: ArchivePublicMessage(row.reason), at: Number(row.created_at) })),
            errors: this.db.prepare('SELECT e.stage,e.message FROM errors e JOIN attempts a ON a.id=e.attempt_id WHERE a.session_id=? ORDER BY e.id DESC LIMIT 100').all(id)
                .map(row => ({ stage: String(row.stage), message: ArchivePublicMessage(row.message) })) };
    }
}
