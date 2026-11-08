import { CatalogVerificationRequired } from './CatalogVerification';
import { Observable } from '../Observable';
import { IndexConflictError, IndexReviewError, IndexStorageError, UnknownCoverage, type IndexSnapshot, type CatalogCoverage, type IndexAttempt, type CatalogEntry } from './SiteIndexContract';
import type { SiteIndexRepository } from './SiteIndexRepository';

export interface CatalogSource {
    id: string;
    name?: string;
    ObserveProgress?(listener: (count: number, status?: number) => void): () => void;
    Catalog(signal: AbortSignal): AsyncIterable<{ items: readonly CatalogEntry[]; terminal: boolean; coverage: CatalogCoverage; httpStatus?: number }>;
    ObserveVerification?(listener: (state: 'required' | 'blocked' | 'cleared') => void): () => void;
    Published?(): void;
}
export interface CatalogLock {
    request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}
interface CatalogPolicy { timeoutMs: number; delayMs: number; retryMs: number; initialTimeoutMs?: number; }
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
    if (/FetchWindow.*Timeout/i.test(value?.name ?? '')) return { code: 'catalog-window-timeout', review: false, retry: false };
    if (value?.name === 'TimeoutError') return { code: 'catalog-timeout', review: false, retry: true };
    if (/403|401|429|captcha|access.denied|not.implemented|forbidden|cloudflarechallenge|vercelchallenge/i.test(`${value?.name} ${value?.message}`)) return { code: 'catalog-access-or-capability-unavailable', review: true, retry: false };
    return { code: 'catalog-fetch-or-storage-failed', review: false, retry: true };
}
/** Metadata only. One request chain and one origin-wide lock; no DownloadManager or chapter/image entry point. */
export class SiteIndexManager {
    public readonly State = new Observable<IndexSnapshot>({ job: null, sites: [] });
    public readonly Activity = new Observable<{ owned: boolean; draining: boolean; error: string; verification?: string; progress?: { siteId: string; observed: number } }>({ owned: false, draining: false, error: '' });
    private stop = new AbortController();
    private requested: 'paused' | 'cancelled' | undefined;
    private id: string | undefined;
    private pending: Promise<unknown> | undefined;
    private settled = true;
    private iterator: AsyncIterator<unknown> | undefined;
    private recovered = false;
    private initializing: Promise<void> | undefined;
    private lastNotification = 0;
    private phase = 'connector-fetch';
    constructor(public readonly Repository: SiteIndexRepository, private readonly sources: () => readonly CatalogSource[], private readonly locks: CatalogLock,
        private readonly policy: CatalogPolicy = { timeoutMs: 60_000, initialTimeoutMs: 180_000, delayMs: 1000, retryMs: 3000 },
        private readonly diagnostic: (runId: string, event: Record<string, unknown>) => Promise<void> = async () => {}) {}
    private Log(event: Record<string, unknown>): void { if (this.id) void this.diagnostic(this.id, event).catch(() => {}); }

    public async Refresh(): Promise<void> { this.State.Value = await this.Repository.Snapshot(); }
    public Initialize(): Promise<void> {
        return this.initializing ??= this.InitializeOnce().finally(() => { this.initializing = undefined; });
    }
    private async InitializeOnce(): Promise<void> {
        if (!this.locks) { this.Activity.Value = { owned: false, draining: false, error: 'Catalog locking is unavailable in this environment' }; await this.Refresh(); return; }
        await this.locks.request('haruneko-site-index', { ifAvailable: true }, async lock => { if (lock && !this.recovered) { await this.Repository.Interrupt(); this.recovered = true; } });
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
                    const previous = await this.Repository.Snapshot();
                    const job = resume ? await this.Repository.Resume() : await this.Repository.Start(ids);
                    this.recovered = true; this.id = job.id; await this.Refresh(); ready = true; resolve();
                    this.Log({ event: resume ? 'resume' : 'begin', type: 'full-refresh', scope: siteId ? 'single' : 'bulk', sites: job.items.length });
                    for (const item of job.items) this.Log({ event: 'previous-index', siteId: item.siteId, index: previous.sites.find(site => site.siteId === item.siteId) ?? { state: 'untracked', lastSuccess: null } });
                    await this.Run();
                } finally {
                    // Legacy FetchMangas may ignore AbortSignal. Never overlap a new site with that live chain.
                    if (!this.settled) { this.Activity.Value = { ...this.Activity.Value, draining: true }; await this.pending?.catch(() => {}); }
                    try { await this.iterator?.return?.(); } catch { /* An aborted source may reject its finalizer. */ }
                    this.iterator = undefined;
                }
            }).catch(async error => {
                this.Activity.Value = { ...this.Activity.Value, error: error instanceof IndexConflictError ? error.message : 'Catalog repository unavailable; progress requires recovery' };
                this.Log({ event: 'service-error', code: 'catalog-recovery-required' });
                if (!ready) reject(error);
                else { await this.Repository.Interrupt().catch(() => {}); await this.Refresh().catch(() => {}); }
            }).finally(() => { this.Log({ event: 'summary', state: this.State.Value.job?.state, sites: this.State.Value.job?.items.length,
                results: this.State.Value.job?.items.reduce((counts, item) => ({ ...counts, [item.state]: (counts[item.state] ?? 0) + 1 }), {} as Record<string, number>) }); this.Activity.Value = { ...this.Activity.Value, owned: false, draining: false, progress: undefined }; });
        });
    }
    private async Run(): Promise<void> {
        while (!this.stop.signal.aborted) {
            const job = (await this.Repository.Snapshot()).job!;
            const item = job.items.find(item => item.state === 'queued') ?? job.items.find(item => item.state === 'ready');
            if (!item) { await this.Repository.State(job.id, job.items.some(item => item.state === 'verification') ? 'waiting' : 'finished'); await this.Refresh(); return; }
            const attempt = await this.Repository.Begin(job.id, item.siteId); await this.Refresh();
            const source = this.sources().find(source => source.id === item.siteId);
            const started = Date.now(); let observed = 0, lastProgressLog = 0, lastHTTP: number | null = null;
            this.Log({ event: 'attempt-begin', siteId: item.siteId, siteName: source?.name, attempt: item.attempts + 1, previous: this.State.Value.sites.find(site => site.siteId === item.siteId), idleTimeoutMs: this.policy.timeoutMs });
            const controller = new AbortController();
            const abort = () => controller.abort(this.stop.signal.reason);
            this.stop.signal.addEventListener('abort', abort, { once: true });
            if (this.stop.signal.aborted) abort();
            let timeout: ReturnType<typeof setTimeout>;
            let awaitingHuman = false;
            let maximum: ReturnType<typeof setTimeout>;
            const maximumDeadline = () => { clearTimeout(maximum); maximum = setTimeout(() => controller.abort(new DOMException('Catalog maximum duration exceeded', 'TimeoutError')), 30 * 60_000); };
            const resetDeadline = (initial = false) => { clearTimeout(timeout); if (!awaitingHuman) timeout = setTimeout(() => controller.abort(new DOMException('Catalog idle deadline exceeded', 'TimeoutError')), initial ? this.policy.initialTimeoutMs ?? this.policy.timeoutMs : this.policy.timeoutMs); };
            resetDeadline(true); maximumDeadline();
            const verification = source?.ObserveVerification?.(state => {
                this.Log({ event: 'verification', siteId: item.siteId, stage: state });
                clearTimeout(timeout); clearTimeout(maximum);
                if (state === 'cleared') { awaitingHuman = false; this.Activity.Value = { ...this.Activity.Value, verification: undefined }; resetDeadline(); maximumDeadline(); }
                else if (state === 'required') { awaitingHuman = true; this.Activity.Value = { ...this.Activity.Value, verification: item.siteId }; }
                else {
                    this.Activity.Value = { ...this.Activity.Value, verification: undefined, draining: true, error: 'The browser window could not close. Stop this update and restart before retrying.' };
                    controller.abort(new Error('Catalog window cleanup failed'));
                }
            });
            const unsubscribe = source?.ObserveProgress?.((count, status) => {
                if (Number.isInteger(status) && status >= 100 && status <= 599) lastHTTP = status;
                if (!Number.isSafeInteger(count) || count <= 0 || controller.signal.aborted) return;
                observed += count; resetDeadline();
                this.Activity.Value = { ...this.Activity.Value, progress: { siteId: item.siteId, observed } };
                if (Date.now() - lastProgressLog >= 1000) { lastProgressLog = Date.now(); this.Log({ event: 'progress', siteId: item.siteId, observed, elapsedMs: Date.now() - started }); }
            });
            try {
                if (!source) throw new IndexReviewError('The original Arabic connector is unavailable');
                controller.signal.throwIfAborted();
                this.phase = 'connector-fetch';
                this.iterator = source.Catalog(controller.signal)[Symbol.asyncIterator]();
                await this.Collect(attempt, controller.signal, () => lastHTTP);
                clearTimeout(timeout);
                controller.signal.throwIfAborted();
                source.Published?.();
                this.Log({ event: 'attempt-success', siteId: item.siteId, elapsedMs: Date.now() - started, httpStatus: lastHTTP, result: (await this.Repository.Snapshot()).sites.find(site => site.siteId === item.siteId) });
            } catch(error) {
                if (this.stop.signal.aborted) { await this.Repository.State(job.id, this.requested ?? 'paused'); await this.Refresh(); return; }
                const verificationNeeded = error instanceof CatalogVerificationRequired;
                const failure = verificationNeeded ? { code: 'catalog-verification-required', review: true, retry: false } : lastHTTP !== null && [401, 403, 429].includes(lastHTTP) ? { code: 'catalog-access-or-capability-unavailable', review: true, retry: false } : Failure(error);
                const name = String((error as Error)?.name ?? 'Error');
                const http = /(?:HTTP|status|response)\D{0,12}([1-5][0-9]{2})/i.exec(String((error as Error)?.message ?? ''))?.[1];
                this.Log({ event: 'attempt-failure', siteId: item.siteId, elapsedMs: Date.now() - started, stage: this.phase, code: failure.code,
                    errorType: /^[A-Za-z0-9_<>:.-]{1,160}$/.test(name) ? name : 'Error', httpStatus: lastHTTP ?? (http ? Number(http) : /Forbidden/.test(name) ? 403 : null),
                    diagnostic: failure.code === 'catalog-timeout' ? 'Connector made no timely progress or exceeded the bounded maximum duration' : failure.code });
                let retained = false;
                if (!(error instanceof IndexStorageError) && !(error instanceof IndexConflictError) && !(error instanceof IndexReviewError) && ![401, 403, 429].includes(lastHTTP ?? 0)) {
                    const candidate = await this.Repository.Candidate(attempt);
                    if (candidate.length) {
                        await this.Repository.Publish(attempt, candidate, { state: 'partial', evidence: `Source stopped: ${failure.code}; only validated observations retained` }, failure.code);
                        retained = true; source?.Published?.();
                        this.Log({ event: 'partial-retained', siteId: item.siteId, count: candidate.length, httpStatus: lastHTTP, code: failure.code });
                    }
                }
                if (verificationNeeded) await this.Repository.Defer(attempt);
                else if (!retained) await this.Repository.Result(attempt, failure.code, failure.review, failure.retry);
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
                clearTimeout(timeout); clearTimeout(maximum); this.Activity.Value = { ...this.Activity.Value, verification: undefined }; unsubscribe?.(); verification?.(); this.stop.signal.removeEventListener('abort', abort);
                if (this.settled) { try { await this.iterator?.return?.(); } catch { /* Original error is recorded separately. */ } this.iterator = undefined; }
            }
            await this.Refresh();
            try { await pause(this.State.Value.job!.items.find(value => value.siteId === item.siteId)!.state === 'queued' ? this.policy.retryMs : this.policy.delayMs, this.stop.signal); }
            catch { await this.Repository.State(job.id, this.requested ?? 'paused'); await this.Refresh(); return; }
        }
        await this.Repository.State(this.id!, this.requested ?? 'paused'); await this.Refresh();
    }
    private async Collect(attempt: IndexAttempt, signal: AbortSignal, httpStatus: () => number | null = () => null): Promise<void> {
        let offset = 0, terminal = false, partial = false, rejected = 0, coverage: CatalogCoverage = { ...UnknownCoverage };
        const seen = new Map<string, string>();
        while (!terminal) {
            signal.throwIfAborted();
            this.settled = false;
            const iterator = this.iterator!;
            this.phase = 'connector-fetch';
            const next = Promise.resolve().then(() => { signal.throwIfAborted(); return iterator.next(); });
            this.pending = next.then(() => { this.settled = true; }, () => { this.settled = true; });
            const result = await AwaitSignal(next, signal) as IteratorResult<{ items: readonly CatalogEntry[]; terminal: boolean; coverage: CatalogCoverage; httpStatus?: number }>;
            if (result.done) break;
            const value = result.value;
            if (!value || !Array.isArray(value.items) || !value.coverage || !['complete', 'partial', 'unknown', 'unsupported'].includes(value.coverage.state)) throw new IndexReviewError('Invalid catalog evidence');
            const status = value.httpStatus ?? httpStatus();
            // A terminal missing pagination page can retain earlier observations, never prove completeness.
            if (status !== null && status >= 400 && !(status === 404 && (value.items.length > 0 || offset > 0))) throw new Error(`HTTP ${status} catalog response`);
            partial ||= status === 404;
            this.phase = 'validation';
            const unique: CatalogEntry[] = [];
            for (let index = 0; index < value.items.length; index++) {
                signal.throwIfAborted();
                if (index % 500 === 499) await pause(0, signal);
                const entry = value.items[index];
                if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 4096 || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 4096) { rejected++; continue; }
                if (seen.has(entry.id) && seen.get(entry.id) !== entry.title) { rejected++; continue; }
                if (!seen.has(entry.id)) { seen.set(entry.id, entry.title); unique.push({ id: entry.id, title: entry.title }); }
            }
            this.phase = 'staging';
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
        this.phase = 'candidate-read';
        const entries = await this.Repository.Candidate(attempt);
        signal.throwIfAborted();
        if (partial || rejected) coverage = { state: 'partial', evidence: rejected ? `${rejected} invalid or ambiguous entries skipped; valid observations retained; source completeness unproven` : 'Partial source observations; source completeness unproven' };
        this.phase = 'publication';
        await this.Repository.Publish(attempt, entries, coverage);
    }
}
