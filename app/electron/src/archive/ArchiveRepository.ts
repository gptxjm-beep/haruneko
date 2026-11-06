import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MigrateArchiveDatabase } from './ArchiveSchema';
import { ArchiveWorkRepository } from './ArchiveWorkRepository';
import { ArchiveUIRepository } from './ArchiveUIRepository';
import { Count, Text, PathKey, RelativePath, IsWithin, SafeMessage, ErrorCode } from './ArchivePaths';
import type { ArchiveAttemptResult, ChapterRegistration } from './ArchiveProtocol';

type Row = Record<string, any>;
const formats = ['image/*', 'application/x-cbz', 'application/epub+zip', 'application/pdf'];
const stages = ['prepare', 'fetch', 'validation', 'temporary-storage', 'export', 'verification', 'cleanup', 'internal', 'repository'];

/** Main-process-only repository. No SQL or native path is accepted from renderer commands. */
export class ArchiveRepository {
    private database!: DatabaseSync;
    private readonly lockToken = randomUUID();
    public readonly StagingDirectory: string;
    private closed = false;
    public readonly Work: ArchiveWorkRepository;
    public readonly UI: ArchiveUIRepository;

    constructor(private readonly filename: string) {
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        this.StagingDirectory = path.join(path.dirname(filename), 'staging');
        fs.mkdirSync(this.StagingDirectory, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(this.StagingDirectory).isSymbolicLink()) throw new Error('Unsafe staging directory');
        if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('Unsafe database path');
        this.AcquireLock();
        try {
            this.database = new DatabaseSync(filename);
            this.database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA locking_mode=EXCLUSIVE;');
            MigrateArchiveDatabase(this.database);
            this.Work = new ArchiveWorkRepository(this.database);
            this.UI = new ArchiveUIRepository(this.database, this.Work);
            this.RecoverInterrupted();
        } catch(error) {
            this.database?.close();
            this.ReleaseLock();
            throw error;
        }
    }

    /** Also used when the renderer is replaced while the main process remains alive. */
    public RecoverInterrupted(): void {
        this.Transaction(() => {
            this.Work.RecoverInterruptedCatalogs();
            this.database.prepare("UPDATE sessions SET state='interrupted', updated_at=? WHERE state='active'").run(Date.now());
            this.database.prepare("UPDATE attempts SET state='interrupted', updated_at=? WHERE state='running'").run(Date.now());
            this.database.prepare("UPDATE session_chapters SET state='Interrupted' WHERE state IN ('Downloading','Verifying')").run();
            this.database.prepare("UPDATE archive_runs SET state='interrupted',reason='Application or renderer stopped without ending the run' WHERE state='running'").run();
        });
    }

    private AcquireLock() {
        const name = this.filename + '.lock';
        if (fs.existsSync(name)) {
            if (fs.lstatSync(name).isSymbolicLink()) throw new Error('Unsafe archive lock');
            const previous = JSON.parse(fs.readFileSync(name, 'utf8'));
            if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.token !== 'string') throw new Error('Archive lock requires review');
            try { process.kill(previous.pid, 0); throw new Error('Archive repository is already open'); }
            catch(error) { if (ErrorCode(error) !== 'ESRCH') throw error; }
            const current = JSON.parse(fs.readFileSync(name, 'utf8'));
            if (current.token !== previous.token) throw new Error('Archive lock changed');
            fs.unlinkSync(name); // Only this repository's verified stale process-lock artifact.
        }
        const descriptor = fs.openSync(name, 'wx', 0o600);
        try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: this.lockToken })); fs.fsyncSync(descriptor); }
        finally { fs.closeSync(descriptor); }
    }

    private ReleaseLock() {
        const name = this.filename + '.lock';
        if (fs.existsSync(name) && JSON.parse(fs.readFileSync(name, 'utf8')).token === this.lockToken) fs.unlinkSync(name);
    }

    public Close(): void {
        if (this.closed) return;
        this.database.close();
        this.ReleaseLock();
        this.closed = true;
    }

    private Transaction<T>(action: () => T): T {
        this.database.exec('BEGIN IMMEDIATE');
        try { const result = action(); this.database.exec('COMMIT'); return result; }
        catch(error) { this.database.exec('ROLLBACK'); throw error; }
    }

    public GrantRoot(nativePath: string): { rootId: string; label: string } {
        const canonical = fs.realpathSync(Text(nativePath, 'selected directory', 8192));
        const stat = fs.statSync(canonical, { bigint: true });
        if (!stat.isDirectory()) throw new Error('Archive root is not a directory');
        const identity = `${stat.dev}:${stat.ino}`;
        for (const root of this.database.prepare('SELECT * FROM roots').all()) {
            if (root.path === canonical) {
                if (root.identity && root.identity !== identity) throw new Error('Archive root identity changed; review required');
                if (!root.identity) this.database.prepare('UPDATE roots SET identity=? WHERE id=?').run(identity, root.id);
                return { rootId: String(root.id), label: String(root.label) };
            }
            if (IsWithin(String(root.path), canonical) || IsWithin(canonical, String(root.path))) throw new Error('Overlapping archive roots require review');
        }
        const id = randomUUID();
        const label = path.basename(canonical) || canonical;
        this.database.prepare('INSERT INTO roots(id,path,label,identity) VALUES(?,?,?,?)').run(id, canonical, label, identity);
        return { rootId: id, label };
    }

    public RootPath(rootId: string): string {
        const root = this.database.prepare('SELECT path FROM roots WHERE id=?').get(Text(rootId, 'root ID', 64));
        if (!root) throw new Error('Unknown archive root');
        return String(root.path);
    }

    public RootStorageIdentity(rootId: string): string {
        const row = this.database.prepare('SELECT identity FROM roots WHERE id=?').get(Text(rootId, 'root ID', 64));
        if (!row?.identity) throw new Error('Archive root requires an explicit directory grant');
        return String(row.identity);
    }

    public VerifyRoot(rootId: string): string {
        const root = this.database.prepare('SELECT * FROM roots WHERE id=?').get(Text(rootId, 'root ID', 64));
        if (!root || !root.identity) throw new Error('Archive root requires an explicit directory grant');
        const native = String(root.path);
        const stat = fs.lstatSync(native, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== root.identity) throw new Error('Archive root identity changed; review required');
        return native;
    }

    public CreateSession(rootId: string, siteId: string, siteName: string, settings: { format: string; useWebsiteSubDirectory: boolean }): string {
        this.RootPath(rootId);
        Text(siteId, 'site ID'); Text(siteName, 'site name');
        if (!settings || !formats.includes(settings.format) || typeof settings.useWebsiteSubDirectory !== 'boolean') throw new Error('Invalid archive settings');
        const id = randomUUID();
        this.database.prepare('INSERT INTO sessions(id,root_id,site_id,site_name,state,settings,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(id, rootId, siteId, siteName, 'active', JSON.stringify({ format: settings.format, useWebsiteSubDirectory: settings.useWebsiteSubDirectory }), Date.now(), Date.now());
        return id;
    }

    public Session(sessionId: string): Row {
        const row = this.database.prepare('SELECT * FROM sessions WHERE id=?').get(Text(sessionId, 'session ID', 64));
        if (!row) throw new Error('Unknown archive session');
        return { ...row, settings: JSON.parse(String(row.settings)) };
    }

    public ListSessions(): Row[] {
        return this.database.prepare('SELECT id,root_id,site_id,site_name,state,started_at,updated_at,index_state FROM sessions ORDER BY started_at DESC LIMIT 200').all();
    }

    public SetSessionState(sessionId: string, state: string): void {
        this.Session(sessionId);
        if (!['active', 'paused', 'closed'].includes(state)) throw new Error('Invalid session state');
        if (state !== 'active' && this.database.prepare("SELECT id FROM attempts WHERE session_id=? AND state='running'").get(sessionId)) throw new Error('Cancel active attempts before pausing or closing');
        this.database.prepare('UPDATE sessions SET state=?,updated_at=? WHERE id=?').run(state, Date.now(), sessionId);
    }

    public RegisterChapter(sessionId: string, input: ChapterRegistration): string {
        const session = this.Session(sessionId);
        if (!input || session.site_id !== Text(input.siteId, 'site ID')) throw new Error('Chapter site does not match session');
        Text(input.mangaId, 'manga ID'); Text(input.chapterId, 'chapter ID'); Text(input.title, 'chapter title', 4096);
        Count(input.position, 'chapter position');
        if (!['unknown', 'connector-contract', 'verified-ascending', 'user-confirmed'].includes(input.orderConfidence)) throw new Error('Invalid order confidence');
        if (typeof input.orderEvidence !== 'string' || input.orderEvidence.length > 2048) throw new Error('Invalid order evidence');
        const expected = input.expectedPages === undefined ? null : Count(input.expectedPages, 'expected pages');
        if (input.expectedPagesTrusted !== undefined && typeof input.expectedPagesTrusted !== 'boolean') throw new Error('Invalid expected page trust');
        if (input.expectedPagesTrusted && (!expected || !input.expectedPagesEvidence)) throw new Error('Trusted page counts require explicit evidence');
        const evidence = input.expectedPagesEvidence === undefined || input.expectedPagesEvidence === '' ? '' : Text(input.expectedPagesEvidence, 'page count evidence');
        const key = createHash('sha256').update(JSON.stringify([input.siteId, input.mangaId, input.chapterId])).digest('hex');
        this.Transaction(() => {
            this.database.prepare('INSERT OR IGNORE INTO chapters(key,site_id,manga_id,chapter_id) VALUES(?,?,?,?)').run(key, input.siteId, input.mangaId, input.chapterId);
            this.database.prepare(`INSERT INTO session_chapters(session_id,chapter_key,title,position,order_confidence,order_evidence,expected_pages,expected_trusted,pages_evidence)
                VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,chapter_key) DO UPDATE SET title=excluded.title,position=excluded.position,
                order_confidence=excluded.order_confidence,order_evidence=excluded.order_evidence,expected_pages=excluded.expected_pages,
                expected_trusted=excluded.expected_trusted,pages_evidence=excluded.pages_evidence`)
                .run(sessionId, key, input.title, input.position, input.orderConfidence, input.orderEvidence, expected, input.expectedPagesTrusted ? 1 : 0, SafeMessage(evidence));
        });
        return key;
    }

    public Chapter(sessionId: string, chapterKey: string): Row {
        const row = this.database.prepare('SELECT * FROM session_chapters WHERE session_id=? AND chapter_key=?').get(Text(sessionId, 'session ID', 64), Text(chapterKey, 'chapter key', 64));
        if (!row) throw new Error('Unknown chapter in session');
        return row;
    }

    public ListChapters(sessionId: string, after = ''): Row[] {
        this.Session(sessionId);
        if (typeof after !== 'string' || after.length > 64) throw new Error('Invalid chapter cursor');
        return this.database.prepare('SELECT * FROM session_chapters WHERE session_id=? AND chapter_key>? ORDER BY chapter_key LIMIT 200').all(sessionId, after);
    }

    public BeginAttempt(sessionId: string, chapterKey: string): string {
        const session = this.Session(sessionId);
        this.Chapter(sessionId, chapterKey);
        if (session.state === 'closed' || session.state === 'paused') throw new Error('Session is not active');
        const id = randomUUID();
        this.Transaction(() => {
            this.database.prepare('INSERT INTO attempts(id,session_id,chapter_key,state,stage,started_at,updated_at) VALUES(?,?,?,?,?,?,?)')
                .run(id, sessionId, chapterKey, 'running', 'prepare', Date.now(), Date.now());
            this.database.prepare("UPDATE sessions SET state='active',updated_at=? WHERE id=?").run(Date.now(), sessionId);
            this.database.prepare("UPDATE session_chapters SET state='Downloading' WHERE session_id=? AND chapter_key=?").run(sessionId, chapterKey);
        });
        return id;
    }

    public Attempt(attemptId: string, requireRunning = false): Row {
        const row = this.database.prepare('SELECT a.*,s.root_id,s.settings FROM attempts a JOIN sessions s ON s.id=a.session_id WHERE a.id=?').get(Text(attemptId, 'attempt ID', 64));
        if (!row || requireRunning && row.state !== 'running') throw new Error('Attempt is not running');
        return { ...row, settings: JSON.parse(String(row.settings)) };
    }

    public Checkpoint(attemptId: string, stage: string, received?: number, validated?: number, expectedFiles?: number): void {
        const attempt = this.Attempt(attemptId, true);
        if (!stages.includes(stage)) throw new Error('Invalid archive stage');
        const r = received === undefined ? Number(attempt.received_pages) : Math.max(Number(attempt.received_pages), Count(received, 'received pages'));
        const v = validated === undefined ? Number(attempt.validated_pages) : Math.max(Number(attempt.validated_pages), Count(validated, 'validated pages'));
        if (v > r) throw new Error('Validated pages exceed received pages');
        const expected = expectedFiles === undefined ? attempt.expected_files : Count(expectedFiles, 'expected files');
        this.Transaction(() => {
            this.database.prepare('UPDATE attempts SET stage=?,received_pages=?,validated_pages=?,expected_files=?,updated_at=? WHERE id=?')
                .run(stage, r, v, expected, Date.now(), attemptId);
            this.database.prepare('UPDATE session_chapters SET state=? WHERE session_id=? AND chapter_key=?')
                .run(stage === 'export' || stage === 'verification' || stage === 'cleanup' ? 'Verifying' : 'Downloading', attempt.session_id, attempt.chapter_key);
        });
    }

    public FindFile(rootId: string, relative: string): Row | undefined {
        return this.database.prepare('SELECT * FROM files WHERE root_id=? AND path_key=?').get(rootId, PathKey(relative));
    }

    public File(fileId: string): Row {
        const row = this.database.prepare('SELECT * FROM files WHERE id=?').get(Text(fileId, 'file ID', 64));
        if (!row) throw new Error('Unknown archive file');
        return row;
    }

    public ReserveFile(attemptId: string, relative: string, size: number): Row {
        const attempt = this.Attempt(attemptId, true);
        RelativePath(relative); Count(size, 'file size', 16 * 1024 ** 3);
        if (attempt.expected_files === null) throw new Error('Export plan must be committed before file writes');
        let file = this.FindFile(attempt.root_id, relative);
        this.Transaction(() => {
            if (file && (file.chapter_key !== attempt.chapter_key || file.format !== attempt.settings.format)) throw new Error('Output path is reserved by different content');
            if (!file) {
                const id = randomUUID();
                this.database.prepare('INSERT INTO files(id,root_id,chapter_key,attempt_id,path,path_key,format,size,state,staging) VALUES(?,?,?,?,?,?,?,?,?,?)')
                    .run(id, attempt.root_id, attempt.chapter_key, attemptId, relative, PathKey(relative), attempt.settings.format, size, 'planned', id + '.part');
                file = this.File(id);
            }
            const count = Number(this.database.prepare('SELECT count(*) AS n FROM attempt_files WHERE attempt_id=?').get(attemptId)!.n);
            if (count >= Number(attempt.expected_files) && !this.database.prepare('SELECT file_id FROM attempt_files WHERE attempt_id=? AND file_id=?').get(attemptId, file.id)) throw new Error('File count exceeds the committed export plan');
            this.database.prepare('INSERT OR IGNORE INTO attempt_files(attempt_id,file_id) VALUES(?,?)').run(attemptId, file.id);
        });
        if (!file) throw new Error('File reservation did not complete');
        return file;
    }

    public SetFileState(fileId: string, state: 'writing' | 'staged' | 'verified', sha256?: string, stamp?: string): void {
        this.File(fileId);
        if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid SHA-256');
        this.database.prepare('UPDATE files SET state=?,sha256=COALESCE(?,sha256),stamp=COALESCE(?,stamp),verified_at=CASE WHEN ?=\'verified\' THEN ? ELSE verified_at END WHERE id=?')
            .run(state, sha256 ?? null, stamp ?? null, state, Date.now(), fileId);
    }

    public ResetMissingFile(fileId: string, attemptId: string, size: number): Row {
        const file = this.File(fileId);
        const attempt = this.Attempt(attemptId, true);
        if (file.chapter_key !== attempt.chapter_key || file.root_id !== attempt.root_id) throw new Error('File ownership mismatch');
        Count(size, 'file size', 16 * 1024 ** 3);
        this.database.prepare("UPDATE files SET attempt_id=?,size=?,sha256=NULL,state='planned',stamp=NULL,verified_at=NULL WHERE id=?").run(attemptId, size, fileId);
        return this.File(fileId);
    }

    public RecordFileReceipt(attemptId: string, fileId: string): void {
        const file = this.File(fileId);
        if (file.state !== 'verified') throw new Error('File is not verified');
        this.database.prepare('UPDATE attempt_files SET receipt_size=?,receipt_sha256=?,receipt_verified_at=? WHERE attempt_id=? AND file_id=?')
            .run(file.size, file.sha256, Date.now(), attemptId, fileId);
    }

    public Conflict(attemptId: string, relative: string, reason: string): void {
        this.Attempt(attemptId);
        this.database.prepare('INSERT OR REPLACE INTO conflicts(attempt_id,path,reason) VALUES(?,?,?)').run(attemptId, RelativePath(relative), SafeMessage(reason));
    }

    public Error(attemptId: string, stage: string, message: string): void {
        this.Attempt(attemptId);
        if (!stages.includes(stage)) throw new Error('Invalid error stage');
        this.database.prepare('INSERT INTO errors(attempt_id,stage,message,created_at) VALUES(?,?,?,?)').run(attemptId, stage, SafeMessage(message), Date.now());
    }

    public FinishAttempt(attemptId: string, result: ArchiveAttemptResult): void {
        const attempt = this.Attempt(attemptId);
        if (!result || !['succeeded', 'succeeded-with-warnings', 'failed', 'cancelled', 'unverified'].includes(result.outcome)
            || !Array.isArray(result.errors) || result.errors.length > 1000 || !Array.isArray(result.cleanupKeys) || result.cleanupKeys.length > 100_000) throw new Error('Invalid attempt result');
        Count(result.receivedPages, 'received pages'); Count(result.validatedPages, 'validated pages');
        if (result.validatedPages > result.receivedPages) throw new Error('Invalid validation count');
        for (const key of result.cleanupKeys) Text(key, 'temporary key', 256);
        if (!['not-needed', 'completed', 'failed'].includes(result.cleanupState)) throw new Error('Invalid cleanup state');
        const snapshot = {
            outcome: result.outcome, receivedPages: result.receivedPages, validatedPages: result.validatedPages,
            outputState: Text(result.outputState, 'output state', 32), verification: Text(result.verification, 'verification state', 32), cleanupState: result.cleanupState,
        };
        this.Transaction(() => {
            this.database.prepare('UPDATE attempts SET state=\'finished\',stage=\'cleanup\',result=?,received_pages=?,validated_pages=?,cleanup_keys=?,updated_at=? WHERE id=?')
                .run(JSON.stringify(snapshot), result.receivedPages, result.validatedPages, JSON.stringify(result.cleanupKeys), Date.now(), attemptId);
            for (const error of result.errors) this.Error(attemptId, Text(error.stage, 'error stage', 32), Text(error.message, 'error message', 2048));
            this.database.prepare('UPDATE session_chapters SET state=? WHERE session_id=? AND chapter_key=?')
                .run(result.outcome === 'cancelled' ? 'Interrupted' : 'Verifying', attempt.session_id, attempt.chapter_key);
        });
    }

    public RecordCleanup(attemptId: string, keys: string[], error?: string): void {
        const attempt = this.Attempt(attemptId);
        if (!Array.isArray(keys) || keys.length > 100_000) throw new Error('Invalid cleanup keys');
        for (const key of keys) Text(key, 'temporary key', 256);
        const previous = JSON.parse(String(attempt.cleanup_keys));
        if (keys.some(key => !previous.includes(key))) throw new Error('Cleanup does not own these keys');
        this.Transaction(() => {
            this.database.prepare('UPDATE attempts SET cleanup_keys=?,updated_at=? WHERE id=?').run(JSON.stringify(keys), Date.now(), attemptId);
            if (error) this.Error(attemptId, 'cleanup', error);
        });
    }

    public RecoveryData(sessionId: string, chapterKey: string): { chapter: Row; session: Row; attempt?: Row; files: Row[]; conflicts: Row[]; otherArtifacts: boolean; cleanup: { attemptId: string; keys: string[] }[] } {
        const session = this.Session(sessionId);
        const chapter = this.Chapter(sessionId, chapterKey);
        const attempt = this.database.prepare(`SELECT a.* FROM attempts a JOIN sessions s ON s.id=a.session_id
            WHERE a.chapter_key=? AND s.root_id=? AND json_extract(s.settings,'$.format')=?
            AND json_extract(s.settings,'$.useWebsiteSubDirectory')=? AND a.expected_files IS NOT NULL
            ORDER BY CASE WHEN a.session_id=? THEN 0 ELSE 1 END,a.started_at DESC,a.rowid DESC LIMIT 1`)
            .get(chapterKey, session.root_id, session.settings.format, session.settings.useWebsiteSubDirectory ? 1 : 0, sessionId);
        const files = attempt ? this.database.prepare(`SELECT f.*,COALESCE(af.receipt_size,f.size) AS expected_size,
            COALESCE(af.receipt_sha256,CASE WHEN f.attempt_id=af.attempt_id THEN f.sha256 ELSE NULL END) AS expected_sha256
            FROM files f JOIN attempt_files af ON af.file_id=f.id WHERE af.attempt_id=? ORDER BY f.path`).all(attempt.id) : [];
        const conflicts = attempt ? this.database.prepare('SELECT path,reason FROM conflicts WHERE attempt_id=?').all(attempt.id) : [];
        const cleanup = this.database.prepare(`SELECT a.id,a.cleanup_keys FROM attempts a JOIN sessions s ON s.id=a.session_id
            WHERE a.chapter_key=? AND s.root_id=? AND a.cleanup_keys<>'[]'`).all(chapterKey, session.root_id)
            .map(row => ({ attemptId: String(row.id), keys: JSON.parse(String(row.cleanup_keys)) as string[] }));
        const otherArtifacts = !!this.database.prepare(`SELECT f.id FROM files f JOIN attempts a ON a.id=f.attempt_id JOIN sessions s ON s.id=a.session_id
            WHERE f.root_id=? AND f.chapter_key=? AND f.format=? AND json_extract(s.settings,'$.useWebsiteSubDirectory')=?
            AND f.id NOT IN (SELECT file_id FROM attempt_files WHERE attempt_id=?) LIMIT 1`)
            .get(session.root_id, chapterKey, session.settings.format, session.settings.useWebsiteSubDirectory ? 1 : 0, attempt?.id ?? '');
        return { chapter, session, attempt, files, conflicts, otherArtifacts, cleanup };
    }

    public SetRecovery(sessionId: string, chapterKey: string, localState: string, sourceState: string): void {
        this.database.prepare('UPDATE session_chapters SET local_state=?,source_state=?,state=? WHERE session_id=? AND chapter_key=?')
            .run(localState, sourceState, localState === 'healthy' && sourceState === 'complete' ? 'Completed' : localState === 'healthy' ? 'Verifying' : 'Interrupted', sessionId, chapterKey);
    }
}
