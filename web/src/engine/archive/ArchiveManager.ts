import { Observable, type IObservable } from '../Observable';
import { ArchivePersistenceError, ArchiveCapacityError } from '../DownloadContract';
import type { DownloadHandle } from '../DownloadContract';
import type { DownloadManager } from '../DownloadManager';
import type { MangaPlugin, Manga } from '../providers/MangaPlugin';
import type { ArchiveClient } from './ArchiveClient';
import { EnqueueArchiveChapter } from './ArchiveDownload';
import { EngineArchiveSource, type ArchiveSource } from './ArchiveSource';
import type { ArchiveRecovery } from '../../../../app/electron/src/archive/ArchiveProtocol';
import { ArchiveDevelopmentLimits as Limits, type ArchivePolicy, type ArchiveRunSnapshot, type ArchiveWorkManga, type ArchiveWorkItem, type ArchiveCoordinatorCommand, type ArchiveEvidence } from '../../../../app/electron/src/archive/ArchiveCoordinatorProtocol';

export const DefaultArchivePolicy: ArchivePolicy = Object.freeze({ maxMangas: 3, maxChapters: 10, delayMs: 1000, retryDelayMs: 5000,
    maxAttempts: 2, languages: [], unknownLanguage: 'review' });
export type ArchiveCapacityCheckpoint = { phase: 'before-session' | 'before-manga' | 'before-chapter' | 'before-temporary-write'; sessionId: string; signal: AbortSignal; bytes?: number };
export interface ArchiveManagerDependencies {
    source?: ArchiveSource;
    beforeCapacity?: (checkpoint: ArchiveCapacityCheckpoint) => Promise<void>;
    /** Dependency seam for deterministic tests; production always defaults to the original engine adapter. */
    enqueue?: typeof EnqueueArchiveChapter;
}

export function ClassifyArchiveError(error: unknown): { reason: string; retryable: boolean } {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    if (/notimplemented|not implemented|unsupported/i.test(message)) return { reason: `unsupported: ${message}`, retryable: false };
    if ([401, 403, 429].includes(Number(status)) || /captcha|cloudflare|forbidden|access denied|\b40[13]\b|\b429\b|rate.?limit/i.test(message)) return { reason: `access-restricted: ${message}`, retryable: false };
    return { reason: `connector-failure: ${message}`, retryable: true };
}

/** One manga and one owned chapter at a time; all work/history lives in SQLite. No UI or live-site entry point. */
export class ArchiveManager {
    private readonly source: ArchiveSource;
    private readonly snapshot = new Observable<ArchiveRunSnapshot | null, ArchiveManager>(null, this);
    private completion?: Promise<ArchiveRunSnapshot>;
    private running = false;
    private requested?: 'paused' | 'cancelled';
    private cancellation = new AbortController();
    private wake = new AbortController();
    private active?: DownloadHandle;
    private currentWork?: { mangaId: string; chapterId: string };
    private resumeStorage = false;

    constructor(private readonly site: MangaPlugin, private readonly downloads: DownloadManager, private readonly client: ArchiveClient,
        public readonly SessionId: string, private readonly policy: ArchivePolicy = DefaultArchivePolicy, private readonly dependencies: ArchiveManagerDependencies = {}) {
        this.source = dependencies.source ?? new EngineArchiveSource(site);
        this.policy = Object.freeze({ ...policy, languages: [...policy.languages] });
        if (this.source.site !== site) throw new Error('Archive source belongs to a different site');
    }

    public get State(): IObservable<ArchiveRunSnapshot | null, ArchiveManager> { return this.snapshot; }

    public Start(): Promise<ArchiveRunSnapshot> {
        if (this.running) return this.completion!;
        this.running = true;
        this.requested = undefined;
        this.currentWork = undefined;
        this.cancellation = new AbortController();
        this.wake = new AbortController();
        this.completion = this.Run().finally(() => { this.running = false; this.active = undefined; });
        return this.completion;
    }

    public Resume(): Promise<ArchiveRunSnapshot> { return this.Start(); }

    /** Graceful pause: finish the current chapter receipt, then persist the pause before another chapter starts. */
    public async Pause(): Promise<ArchiveRunSnapshot> {
        if (!this.running) return this.Refresh();
        if (this.requested !== 'cancelled') this.requested = 'paused';
        this.wake.abort();
        return this.completion!;
    }

    public async Cancel(): Promise<ArchiveRunSnapshot> {
        if (!this.running) {
            await this.Command({ operation: 'archive-run-state', sessionId: this.SessionId, state: 'cancelled', reason: 'Cancelled by caller' });
            return this.Refresh();
        }
        this.requested = 'cancelled';
        this.cancellation.abort(new Error('Archive session cancelled'));
        this.wake.abort();
        this.active?.cancel('Archive session cancelled');
        return this.completion!;
    }

    private Command<T>(command: ArchiveCoordinatorCommand): Promise<T> { return this.client.Request<T>(command); }
    private async Refresh(): Promise<ArchiveRunSnapshot> {
        const snapshot = await this.Command<ArchiveRunSnapshot>({ operation: 'archive-run-snapshot', sessionId: this.SessionId });
        this.snapshot.Value = snapshot;
        return snapshot;
    }

    private async Wait(milliseconds: number): Promise<void> {
        if (this.requested) return;
        await new Promise<void>(resolve => {
            const signal = this.wake.signal;
            const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve(); };
            const timer = setTimeout(end, Math.min(60_000, Math.max(0, milliseconds)));
            signal.addEventListener('abort', end, { once: true });
            if (signal.aborted) end();
        });
    }

    private async Capacity(phase: ArchiveCapacityCheckpoint['phase']) {
        await this.client.Request({ operation: 'storage-check', sessionId: this.SessionId });
        await this.dependencies.beforeCapacity?.({ phase, sessionId: this.SessionId, signal: this.cancellation.signal });
        this.cancellation.signal.throwIfAborted();
    }

    private async Catalog(): Promise<void> {
        while (!this.requested) {
            const before = await this.Refresh();
            if (before.catalogDone) return;
            if (before.catalogAttempts >= this.policy.maxAttempts || before.catalogPages >= Limits.catalogPages) {
                await this.Command({ operation: 'archive-catalog-end', sessionId: this.SessionId, index: { state: 'partial', evidence: 'Catalog attempt/page development limit reached' } });
                return;
            }
            await this.Command({ operation: 'archive-catalog-begin', sessionId: this.SessionId });
            let items = 0;
            let terminal = false;
            let coverage: ArchiveEvidence = { state: 'unknown', evidence: 'No terminal index evidence' };
            try {
                const pages = this.source.Catalog(this.cancellation.signal)[Symbol.asyncIterator]();
                try {
                    while (!this.requested) {
                        await this.Wait(this.policy.delayMs);
                        if (this.requested) return;
                        const page = await pages.next();
                        if (page.done) break;
                        if (terminal) throw new Error('Connector emitted data after its terminal catalog page');
                        const current = await this.Refresh();
                        if (current.catalogPages >= Limits.catalogPages) { coverage = { state: 'partial', evidence: 'Catalog page limit reached' }; break; }
                        await this.Command({ operation: 'archive-catalog-page', sessionId: this.SessionId, items: [...page.value.items] });
                        items += page.value.items.length;
                        terminal = page.value.terminal;
                        coverage = page.value.coverage;
                    }
                } finally { await pages.return?.(); }
                if (this.requested) return;
                if (!items && coverage.state !== 'unsupported' && (await this.Refresh()).catalogAttempts < this.policy.maxAttempts) {
                    await this.Command({ operation: 'archive-catalog-failed', sessionId: this.SessionId, reason: 'Empty catalog; bounded delayed recheck' });
                    await this.Command({ operation: 'archive-note', sessionId: this.SessionId, kind: 'catalog-retry', reason: 'Empty catalog; bounded delayed recheck' });
                    await this.Wait(this.policy.retryDelayMs); continue;
                }
                if (!items && coverage.state === 'complete') coverage = { state: 'unknown', evidence: 'Empty enumeration is not proof of a complete index' };
                if (!terminal && coverage.state === 'complete') coverage = { state: 'unknown', evidence: 'Index enumeration ended without terminal evidence' };
                await this.Command({ operation: 'archive-catalog-end', sessionId: this.SessionId, index: coverage });
                return;
            } catch(error) {
                if (error instanceof ArchivePersistenceError || error instanceof ArchiveCapacityError) throw error;
                if (this.requested === 'cancelled' && (error === this.cancellation.signal.reason || error instanceof DOMException && error.name === 'AbortError')) return;
                const failure = ClassifyArchiveError(error);
                await this.Command({ operation: 'archive-catalog-failed', sessionId: this.SessionId, reason: failure.reason });
                if (this.requested) return;
                if (!items && failure.retryable && (await this.Refresh()).catalogAttempts < this.policy.maxAttempts) {
                    await this.Command({ operation: 'archive-note', sessionId: this.SessionId, kind: 'catalog-retry', reason: failure.reason });
                    await this.Wait(this.policy.retryDelayMs); continue;
                }
                await this.Command({ operation: 'archive-catalog-end', sessionId: this.SessionId,
                    index: { state: failure.reason.startsWith('unsupported') ? 'unsupported' : items ? 'partial' : 'unknown', evidence: failure.reason } });
                return;
            } finally {
                if (this.requested) await this.Command({ operation: 'archive-catalog-interrupt', sessionId: this.SessionId, reason: this.requested });
            }
        }
    }

    private async Manifest(manga: Manga): Promise<boolean> {
        try {
            if (this.requested) return false;
            const manifest = await this.source.Chapters(manga, this.cancellation.signal);
            // A graceful pause must not discard a successfully returned manifest and spend a retry on resume.
            if (this.requested === 'cancelled') return false;
            if (!manifest.chapters.length) {
                await this.Command({ operation: 'archive-manga-defer', sessionId: this.SessionId, mangaId: manga.Identifier, reason: 'empty-chapter-list: temporary emptiness is not completion', retryable: true });
                return false;
            }
            const manifestId = await this.Command<string>({ operation: 'archive-manifest-begin', sessionId: this.SessionId, mangaId: manga.Identifier, count: manifest.chapters.length,
                order: manifest.order === 'unknown' ? 'unknown' : 'ascending',
                orderEvidence: manifest.sequenceOnly ? manifest.orderEvidence : `Original ${manifest.order}; normalized oldest-first once. ${manifest.orderEvidence}`, evidence: manifest.coverage });
            for (let offset = 0; offset < manifest.chapters.length; offset += Limits.chapterBatchSize) {
                if (this.cancellation.signal.aborted) return false;
                const chapters: (typeof manifest.chapters)[number][] = [];
                for (let position = offset; position < Math.min(offset + Limits.chapterBatchSize, manifest.chapters.length); position++) {
                    const index = manifest.order === 'descending' ? manifest.chapters.length - 1 - position : position;
                    chapters.push({ ...manifest.chapters[index], position });
                }
                await this.Command({ operation: 'archive-manifest-batch', sessionId: this.SessionId, mangaId: manga.Identifier, manifestId, offset, chapters });
            }
            if (this.cancellation.signal.aborted) return false;
            await this.Command({ operation: 'archive-manifest-end', sessionId: this.SessionId, mangaId: manga.Identifier, manifestId });
            return true;
        } catch(error) {
            if (error instanceof ArchivePersistenceError || error instanceof ArchiveCapacityError || this.requested) throw error;
            const failure = ClassifyArchiveError(error);
            await this.Command({ operation: 'archive-manga-defer', sessionId: this.SessionId, mangaId: manga.Identifier, reason: failure.reason, retryable: failure.retryable });
            return false;
        }
    }

    private async Chapter(manga: Manga, item: ArchiveWorkItem): Promise<boolean> {
        const report = async (state: 'healthy' | 'review' | 'failed' | 'pending', reason: string, retryable = false) => {
            await this.Command({ operation: 'archive-chapter-result', sessionId: this.SessionId, mangaId: manga.Identifier, chapterId: item.id, state, reason, retryable });
        };
        await this.client.Request({ operation: 'storage-check', sessionId: this.SessionId });
        let recovery = await this.client.Request<ArchiveRecovery>({ operation: 'recover-chapter', sessionId: this.SessionId, chapterKey: item.chapter_key });
        if (this.resumeStorage && recovery.action === 'publish-staged') {
            for (const file of recovery.files) if (file.state === 'staged') await this.client.Request({ operation: 'publish-staged', fileId: file.fileId });
            recovery = await this.client.Request<ArchiveRecovery>({ operation: 'recover-chapter', sessionId: this.SessionId, chapterKey: item.chapter_key });
        }
        if (recovery.action === 'reuse') { await report('healthy', recovery.cleanup.length || recovery.stagingCleanup.length ? 'Verified output reused; independent cleanup remains pending' : 'Verified output reused'); return true; }
        if (recovery.action !== 'retry-missing') { await report('review', `Recovery requires ${recovery.action}; local state ${recovery.localState}`); return true; }
        if (item.attempts >= this.policy.maxAttempts) { await report('review', 'Chapter retry budget exhausted; missing output requires review'); return true; }
        const before = await this.Refresh();
        if (before.chaptersStarted >= this.policy.maxChapters) return false;
        await this.Capacity('before-chapter');
        await this.Wait(this.policy.delayMs);
        if (this.requested) return true;
        await this.Command({ operation: 'archive-chapter-begin', sessionId: this.SessionId, mangaId: manga.Identifier, chapterId: item.id });
        try {
            const submitted = await (this.dependencies.enqueue ?? EnqueueArchiveChapter)(this.downloads, this.client, this.SessionId, manga.CreateEntry(item.id, item.title), {
                siteId: this.site.Identifier, mangaId: manga.Identifier, chapterId: item.id, title: item.title, position: item.position,
                orderConfidence: this.source.executionOrderConfidence ?? 'connector-contract', orderEvidence: this.source.executionOrderConfidence ? 'User-selected execution sequence; chronology may be unproven' : 'Saved oldest-first connector manifest; no title-number inference',
                expectedPages: item.expected_pages ?? undefined, expectedPagesTrusted: !!item.expected_trusted, expectedPagesEvidence: item.pages_evidence,
            }, { signal: this.cancellation.signal, pageDelayMs: this.policy.delayMs,
                beforeTemporaryWrite: bytes => this.dependencies.beforeCapacity?.({ phase: 'before-temporary-write', sessionId: this.SessionId, signal: this.cancellation.signal, bytes }) ?? Promise.resolve() });
            if (submitted.kind !== 'download') { await report(submitted.kind === 'reuse' ? 'healthy' : 'review', `Recovery decision: ${submitted.kind}`); return true; }
            this.active = submitted.handle;
            const result = await submitted.handle.completion;
            this.active = undefined;
            const capacityFailure = result.errors.find(error => error.error instanceof ArchiveCapacityError);
            if (capacityFailure) throw capacityFailure.error;
            if (result.errors.some(error => error.stage === 'repository')) throw new ArchivePersistenceError('Chapter receipt could not be committed');
            const after = await this.client.Request<ArchiveRecovery>({ operation: 'recover-chapter', sessionId: this.SessionId, chapterKey: item.chapter_key });
            if (result.outcome === 'cancelled') { await report('pending', 'Cancelled owned attempt; existing output preserved'); return true; }
            if (item.expected_trusted && item.expected_pages !== result.fetch.receivedPages) { await report('review', `page-count-mismatch: trusted ${item.expected_pages}, received ${result.fetch.receivedPages}`); return true; }
            if (after.action === 'reuse') { await report('healthy', result.cleanup.state === 'failed' ? 'Verified output; cleanup failure does not require image download' : 'Verified output; source/index coverage is independent'); return true; }
            const fetchOnly = result.errors.length > 0 && result.errors.every(error => error.stage === 'fetch');
            const failure = ClassifyArchiveError(result.errors[0]?.error ?? new Error(result.outcome));
            await report(fetchOnly && after.action === 'retry-missing' ? 'failed' : 'review', `${after.localState}: ${failure.reason}`, fetchOnly && failure.retryable && after.action === 'retry-missing');
        } catch(error) {
            this.active = undefined;
            if (error instanceof ArchivePersistenceError || error instanceof ArchiveCapacityError) throw error;
            await report(this.requested === 'cancelled' ? 'pending' : 'review', ClassifyArchiveError(error).reason);
        }
        return true;
    }

    private async Run(): Promise<ArchiveRunSnapshot> {
        const session = await this.client.Request<{ site_id: string }>({ operation: 'session', sessionId: this.SessionId });
        if (session.site_id !== this.site.Identifier) throw new Error('Session belongs to a different site');
        const opened = await this.Command<ArchiveRunSnapshot>({ operation: 'archive-run-open', sessionId: this.SessionId, policy: this.policy });
        this.resumeStorage = !!opened.storageError;
        let state: 'limited' | 'review' | 'drained' | 'failed' = 'review';
        let reason = 'Observed work drained; no site-completeness inference';
        try {
            await this.Capacity('before-session');
            await this.Catalog();
            while (!this.requested) {
                const next = await this.Command<ArchiveWorkManga | null>({ operation: 'archive-next-manga', sessionId: this.SessionId, now: Date.now() });
                if (!next) {
                    const status = await this.Refresh();
                    if (status.nextRetry !== null) { await this.Wait(status.nextRetry - Date.now()); continue; }
                    state = status.index.state === 'complete' && !status.counts['manga:review'] && !status.counts.review && !status.counts.failed && !status.counts.excluded ? 'drained' : 'review';
                    break;
                }
                const status = await this.Refresh();
                if (!next.admitted && status.mangasUsed >= this.policy.maxMangas) { state = 'limited'; reason = 'Cumulative development manga limit reached'; break; }
                await this.Capacity('before-manga');
                if (this.requested) break;
                if (!next.listed) await this.Wait(this.policy.delayMs);
                if (this.requested) break;
                const claimed = await this.Command<{ needsListing: boolean }>({ operation: 'archive-manga-begin', sessionId: this.SessionId, mangaId: next.id });
                const manga = this.site.CreateEntry(next.id, next.title);
                if (claimed.needsListing && !await this.Manifest(manga)) continue;
                while (!this.requested) {
                    const item = await this.Command<ArchiveWorkItem | null>({ operation: 'archive-next-chapter', sessionId: this.SessionId, mangaId: next.id, now: Date.now() });
                    if (!item) break;
                    this.currentWork = { mangaId: next.id, chapterId: item.id };
                    if (!await this.Chapter(manga, item)) { state = 'limited'; reason = 'Cumulative development chapter limit reached'; break; }
                    this.currentWork = undefined;
                    await this.Refresh();
                }
                if (state === 'limited' || this.requested) break;
                // Empty/failed manifests remain on the delayed review queue, not marked done.
                await this.Command({ operation: 'archive-manga-end', sessionId: this.SessionId, mangaId: next.id });
            }
        } catch(error) {
            if (error instanceof ArchiveCapacityError && this.requested !== 'cancelled') {
                try {
                    await this.Command({ operation: 'archive-storage-stop', sessionId: this.SessionId, ...this.currentWork,
                        fault: error.Fault ?? { code: 'unmeasurable', location: 'archive' } });
                    return await this.Refresh();
                } catch(persistenceError) { throw new AggregateError([error, persistenceError], 'Archive storage stopped; pause receipt could not be saved', { cause: error }); }
            }
            state = 'failed'; reason = error instanceof Error ? error.message : String(error);
            if (!this.requested) {
                // Fail closed. If SQLite is unavailable this commit can fail too; reopening marks the run interrupted.
                try {
                    await this.Command({ operation: 'archive-run-state', sessionId: this.SessionId, state, reason });
                    await this.Refresh();
                } catch(persistenceError) { throw new AggregateError([error, persistenceError], 'Archive stopped; failure checkpoint could not be saved', { cause: error }); }
                throw error;
            }
        }
        await this.Command({ operation: 'archive-run-state', sessionId: this.SessionId, state: this.requested ?? state, reason: this.requested ? `Requested ${this.requested}; no next work started` : reason });
        return this.Refresh();
    }
}
