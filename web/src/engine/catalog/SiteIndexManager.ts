import { Observable } from '../Observable';
import { IndexConflictError, IndexReviewError, IndexStorageError, UnknownCoverage, type IndexSnapshot, type CatalogCoverage, type IndexAttempt, type CatalogEntry } from './SiteIndexContract';
import type { SiteIndexRepository } from './SiteIndexRepository';

export interface CatalogSource {
    id: string;
    Catalog(signal: AbortSignal): AsyncIterable<{ items: readonly CatalogEntry[]; terminal: boolean; coverage: CatalogCoverage }>;
    Published?(): void;
}
export interface CatalogLock {
    request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});
function AwaitSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
    });
}
function Failure(error: unknown): { code: string; review: boolean; retry: boolean } {
    if (error instanceof IndexStorageError) return { code: 'catalog-storage-failed', review: false, retry: false };
    if (error instanceof IndexReviewError) return { code: 'catalog-needs-review: previous index retained', review: true, retry: false };
    if (error instanceof IndexConflictError) return { code: 'catalog-conflict: a newer manual update or job state was preserved', review: true, retry: false };
    const value = error as Error;
    if (value?.name === 'TimeoutError') return { code: 'catalog-timeout', review: false, retry: true };
    if (/403|401|429|captcha|access.denied|not.implemented/i.test(value?.message ?? '')) return { code: 'catalog-access-or-capability-unavailable', review: true, retry: false };
    return { code: 'catalog-fetch-or-storage-failed', review: false, retry: true };
}
/** Metadata only. One request chain and one origin-wide lock; no DownloadManager or chapter/image entry point. */
export class SiteIndexManager {
    public readonly State = new Observable<IndexSnapshot>({ job: null, sites: [] });
    public readonly Activity = new Observable({ owned: false, draining: false, error: '' });
    private stop = new AbortController();
    private requested: 'paused' | 'cancelled' | undefined;
    private id: string | undefined;
    private pending: Promise<unknown> | undefined;
    private settled = true;
    private iterator: AsyncIterator<unknown> | undefined;
    private initializing: Promise<void> | undefined;
    private lastNotification = 0;
    constructor(public readonly Repository: SiteIndexRepository, private readonly sources: () => readonly CatalogSource[], private readonly locks: CatalogLock,
        private readonly policy = { timeoutMs: 60_000, delayMs: 1000, retryMs: 3000 }) {}

    public async Refresh(): Promise<void> { this.State.Value = await this.Repository.Snapshot(); }
    public Initialize(): Promise<void> {
        return this.initializing ??= this.InitializeOnce().finally(() => { this.initializing = undefined; });
    }
    private async InitializeOnce(): Promise<void> {
        if (!this.locks) { this.Activity.Value = { owned: false, draining: false, error: 'Catalog locking is unavailable in this environment' }; await this.Refresh(); return; }
        await this.locks.request('haruneko-site-index', { ifAvailable: true }, async lock => { if (lock) await this.Repository.Interrupt(); });
        await this.Refresh();
    }
    public Start(siteId?: string): Promise<void> { return this.Open(false, siteId); }
    public Resume(): Promise<void> { return this.Open(true); }
    public async Stop(cancel = false): Promise<void> {
        if (this.Activity.Value.owned) {
            this.requested = cancel ? 'cancelled' : 'paused';
            this.stop.abort(new DOMException('Catalog stopped by user', 'AbortError'));
            if (this.id) await this.Repository.State(this.id, this.requested);
            await this.Refresh();
        } else {
            await this.locks.request('haruneko-site-index', { ifAvailable: true }, async lock => {
                if (!lock) throw new IndexConflictError('Another catalog updater is active');
                const job = (await this.Repository.Snapshot()).job;
                if (job && cancel) await this.Repository.State(job.id, 'cancelled');
            });
            await this.Refresh();
        }
    }
    private async Open(resume: boolean, siteId?: string): Promise<void> {
        if (!this.locks || this.Activity.Value.owned) return Promise.reject(new IndexConflictError('Catalog updater is active or unavailable'));
        this.Activity.Value = { owned: true, draining: false, error: '' };
        this.stop = new AbortController(); this.requested = undefined; this.id = undefined;
        try { await this.initializing; } catch(error) { this.Activity.Value = { owned: false, draining: false, error: 'Catalog initialization failed' }; throw error; }
        let ready = false;
        return new Promise<void>((resolve, reject) => {
            void this.locks.request('haruneko-site-index', { ifAvailable: true }, async lock => {
                if (!lock) throw new IndexConflictError('Another catalog updater is active');
                try {
                    const ids = this.sources().map(source => source.id).filter(id => !siteId || id === siteId);
                    if (!resume && !ids.length) throw new IndexConflictError('The selected Arabic manga connector is unavailable');
                    const job = resume ? await this.Repository.Resume() : await this.Repository.Start(ids);
                    this.id = job.id; await this.Refresh(); ready = true; resolve();
                    await this.Run();
                } finally {
                    // Legacy FetchMangas may ignore AbortSignal. Never overlap a new site with that live chain.
                    if (!this.settled) { this.Activity.Value = { ...this.Activity.Value, draining: true }; await this.pending?.catch(() => {}); }
                    try { await this.iterator?.return?.(); } catch { /* An aborted source may reject its finalizer. */ }
                    this.iterator = undefined;
                }
            }).catch(async error => {
                this.Activity.Value = { ...this.Activity.Value, error: error instanceof IndexConflictError ? error.message : 'Catalog repository unavailable; progress requires recovery' };
                if (!ready) reject(error);
                else { await this.Repository.Interrupt().catch(() => {}); await this.Refresh().catch(() => {}); }
            }).finally(() => { this.Activity.Value = { ...this.Activity.Value, owned: false, draining: false }; });
        });
    }
    private async Run(): Promise<void> {
        while (!this.stop.signal.aborted) {
            const job = (await this.Repository.Snapshot()).job!;
            const item = job.items.find(item => item.state === 'queued');
            if (!item) { await this.Repository.State(job.id, 'finished'); await this.Refresh(); return; }
            const attempt = await this.Repository.Begin(job.id, item.siteId); await this.Refresh();
            const source = this.sources().find(source => source.id === item.siteId);
            const controller = new AbortController();
            const abort = () => controller.abort(this.stop.signal.reason);
            this.stop.signal.addEventListener('abort', abort, { once: true });
            if (this.stop.signal.aborted) abort();
            const timeout = setTimeout(() => controller.abort(new DOMException('Catalog deadline exceeded', 'TimeoutError')), this.policy.timeoutMs);
            try {
                if (!source) throw new IndexReviewError('The original Arabic connector is unavailable');
                controller.signal.throwIfAborted();
                this.iterator = source.Catalog(controller.signal)[Symbol.asyncIterator]();
                await this.Collect(attempt, controller.signal);
                clearTimeout(timeout);
                controller.signal.throwIfAborted();
                source.Published?.();
            } catch(error) {
                if (this.stop.signal.aborted) { await this.Repository.State(job.id, this.requested ?? 'paused'); await this.Refresh(); return; }
                const failure = Failure(error);
                await this.Repository.Result(attempt, failure.code, failure.review, failure.retry);
                if (!this.settled) {
                    // Wait conservatively without blocking UI controls. Continue the requested batch only
                    // once the old transport settles; a deliberate user stop must never auto-resume.
                    await this.Repository.State(job.id, 'paused');
                    this.Activity.Value = { ...this.Activity.Value, draining: true }; await this.Refresh();
                    try { await AwaitSignal(this.pending!, this.stop.signal); }
                    catch { await this.Repository.State(job.id, this.requested ?? 'paused'); await this.Refresh(); return; }
                    if (this.stop.signal.aborted) { await this.Repository.State(job.id, this.requested ?? 'paused'); await this.Refresh(); return; }
                    await this.Repository.Resume();
                    this.Activity.Value = { ...this.Activity.Value, draining: false };
                }
            } finally {
                clearTimeout(timeout); this.stop.signal.removeEventListener('abort', abort);
                if (this.settled) { try { await this.iterator?.return?.(); } catch { /* Original error is recorded separately. */ } this.iterator = undefined; }
            }
            await this.Refresh();
            try { await pause(this.State.Value.job!.items.find(value => value.siteId === item.siteId)!.state === 'queued' ? this.policy.retryMs : this.policy.delayMs, this.stop.signal); }
            catch { await this.Repository.State(job.id, this.requested ?? 'paused'); await this.Refresh(); return; }
        }
        await this.Repository.State(this.id!, this.requested ?? 'paused'); await this.Refresh();
    }
    private async Collect(attempt: IndexAttempt, signal: AbortSignal): Promise<void> {
        let offset = 0, terminal = false, partial = false, rejected = 0, coverage: CatalogCoverage = { ...UnknownCoverage };
        const seen = new Map<string, string>();
        while (!terminal) {
            signal.throwIfAborted();
            this.settled = false;
            const iterator = this.iterator!;
            const next = Promise.resolve().then(() => { signal.throwIfAborted(); return iterator.next(); });
            this.pending = next.then(() => { this.settled = true; }, () => { this.settled = true; });
            const result = await AwaitSignal(next, signal) as IteratorResult<{ items: readonly CatalogEntry[]; terminal: boolean; coverage: CatalogCoverage }>;
            if (result.done) break;
            const value = result.value;
            if (!value || !Array.isArray(value.items) || !value.coverage || !['complete', 'partial', 'unknown', 'unsupported'].includes(value.coverage.state)) throw new IndexReviewError('Invalid catalog evidence');
            const unique: CatalogEntry[] = [];
            for (let index = 0; index < value.items.length; index++) {
                signal.throwIfAborted();
                if (index % 500 === 499) await pause(0, signal);
                const entry = value.items[index];
                if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 4096 || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 4096) { rejected++; continue; }
                if (seen.has(entry.id) && seen.get(entry.id) !== entry.title) { rejected++; continue; }
                if (!seen.has(entry.id)) { seen.set(entry.id, entry.title); unique.push({ id: entry.id, title: entry.title }); }
            }
            if (!unique.length) await this.Repository.Stage(attempt, offset, []);
            for (let start = 0; start < unique.length; start += 500) { signal.throwIfAborted(); const batch = unique.slice(start, start + 500); await this.Repository.Stage(attempt, offset, batch); offset += batch.length; }
            if (Date.now() - this.lastNotification >= 150) { await this.Refresh(); this.lastNotification = Date.now(); }
            await pause(0, signal);
            terminal = value.terminal === true;
            coverage = { state: value.coverage.state, evidence: typeof value.coverage.evidence === 'string' ? value.coverage.evidence.slice(0, 2048) : '' };
            partial ||= coverage.state === 'partial' || coverage.state === 'unsupported';
        }
        signal.throwIfAborted();
        if (coverage.state === 'complete' && !terminal) coverage = { ...UnknownCoverage, evidence: 'Enumeration ended without terminal completeness evidence' };
        const entries = await this.Repository.Candidate(attempt);
        signal.throwIfAborted();
        if (partial || rejected) coverage = { state: 'partial', evidence: rejected ? `${rejected} invalid or ambiguous entries skipped; valid observations retained; source completeness unproven` : 'Partial source observations; source completeness unproven' };
        await this.Repository.Publish(attempt, entries, coverage);
    }
}
