import { CatalogVerificationRequired } from './CatalogVerification';
import { describe, expect, it, vi } from 'vitest';
import { SiteIndexManager, type CatalogLock, type CatalogSource } from './SiteIndexManager';
import { IndexConflictError, IndexStorageError, EmptyIndexSite, type IndexJob, type IndexSite, type IndexAttempt, type CatalogEntry, type CatalogCoverage } from './SiteIndexContract';
import type { SiteIndexRepository } from './SiteIndexRepository';

// Manager scheduling fixture only. Publication and transaction policy are tested separately against real IndexedDB in Electron.
class Ledger {
    job: IndexJob | null = null;
    sites = new Map<string, IndexSite>();
    candidates = new Map<string, CatalogEntry[]>();
    published = vi.fn();
    async Snapshot() { return structuredClone({ job: this.job, sites: [...this.sites.values()] }); }
    async Start(ids: string[]) {
        if (this.job && !['cancelled', 'finished'].includes(this.job.state)) throw new IndexConflictError();
        this.job = { key: 'arabic-sites', id: crypto.randomUUID(), state: 'running', items: ids.map(siteId => ({ siteId, state: 'queued', attempts: 0 })), current: null, updatedAt: 0 };
        for (const id of ids) this.sites.set(id, EmptyIndexSite(id));
        return this.job;
    }
    async Interrupt() { if (this.job?.state === 'running') this.job.state = 'interrupted'; }
    async Resume() {
        if (!this.job || ['cancelled', 'finished'].includes(this.job.state)) throw new IndexConflictError();
        for (const item of this.job.items) if (item.state === 'updating') item.state = item.attempts >= 2 ? 'review' : 'queued';
        this.job.state = 'running'; return this.job;
    }
    async Begin(jobId: string, siteId: string) {
        const item = this.job!.items.find(item => item.siteId === siteId)!; item.state = 'updating'; item.attempts++;
        this.job!.current = siteId; this.sites.get(siteId)!.state = 'updating';
        return { jobId, siteId, id: crypto.randomUUID(), revision: 0 };
    }
    async Stage(attempt: IndexAttempt, _offset: number, entries: CatalogEntry[]) { this.candidates.set(attempt.id, [...this.candidates.get(attempt.id) ?? [], ...entries]); }
    async Candidate(attempt: IndexAttempt) { return this.candidates.get(attempt.id) ?? []; }
    async Publish(attempt: IndexAttempt, entries: CatalogEntry[], coverage: CatalogCoverage, problem?: string) {
        this.published(attempt.siteId, entries, coverage); this.job!.items.find(item => item.siteId === attempt.siteId)!.state = problem ? 'review' : 'succeeded';
        Object.assign(this.sites.get(attempt.siteId)!, { state: problem ? 'review' : 'succeeded', count: entries.length, coverage, error: problem }); this.job!.current = null;
    }
    async Defer(attempt: IndexAttempt) {
        const item = this.job!.items.find(item => item.siteId === attempt.siteId)!; item.state = 'verification'; item.attempts--; this.job!.current = null;
        this.sites.get(item.siteId)!.state = 'verification';
    }
    async VerificationReady(id: string) { this.job!.items.find(item => item.siteId === id)!.state = 'ready'; }
    async Result(attempt: IndexAttempt, error: string, review: boolean, retry: boolean) {
        const item = this.job!.items.find(item => item.siteId === attempt.siteId)!;
        item.state = retry && item.attempts < 2 ? 'queued' : review ? 'review' : 'failed';
        Object.assign(this.sites.get(attempt.siteId)!, { state: item.state, error }); this.job!.current = null;
    }
    async State(_id: string, state: IndexJob['state']) {
        this.job!.state = state;
        if (state === 'paused' || state === 'cancelled') for (const item of this.job!.items) if (['queued', 'updating'].includes(item.state)) {
            if (item.state === 'updating') item.attempts--;
            item.state = state === 'cancelled' ? 'cancelled' : 'queued';
        }
    }
}
function lock(): CatalogLock {
    let held = false;
    return { async request(_name, _options, action) { if (held) return action(null); held = true; try { return await action({}); } finally { held = false; } } };
}
const unknown: CatalogCoverage = { state: 'unknown', evidence: 'Fixture observations only' };
const source = (id: string): CatalogSource => ({ id, Catalog: async function* () { yield { items: [{ id: 'm', title: 'M' }], terminal: true, coverage: unknown }; } });
const wait = async (predicate: () => boolean) => { for (let i = 0; i < 2000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('Manager did not settle'); };
const manager = (ledger: Ledger, sources: CatalogSource[], mutex = lock(), timeoutMs = 2000) => new SiteIndexManager(ledger as unknown as SiteIndexRepository, () => sources, mutex, { timeoutMs, delayMs: 1, retryMs: 1 });

describe('Sequential metadata-only site indexing', () => {
    it('Should defer six confirmed challenges durably and resume only ready sources without exhausting connector retry budgets', async () => {
        const ledger = new Ledger(), calls = new Map<string, number>();
        const sites = Array.from({ length: 6 }, (_, n) => ({ id: `verify-${n}`, Catalog: async function* () { const count = (calls.get(`verify-${n}`) ?? 0) + 1; calls.set(`verify-${n}`, count); if (count === 1) throw new CatalogVerificationRequired(); yield { items: [{ id: 'm', title: 'M' }], terminal: true, coverage: unknown }; } }));
        const run = manager(ledger, [...sites, source('normal')]); await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.job?.state).toBe('waiting'); expect(ledger.job?.items.filter(item => item.state === 'verification')).toHaveLength(6);
        expect(ledger.job?.items.slice(0, 6).every(item => item.attempts === 0)).toBe(true);
        await ledger.VerificationReady('verify-2'); const restored = manager(ledger, sites); await restored.Resume(); await wait(() => !restored.Activity.Value.owned);
        expect(ledger.job?.state).toBe('waiting'); expect(calls.get('verify-2')).toBe(2); expect(calls.get('verify-0')).toBe(1);
    });
    it('Should finish normal queued sites before a deferred source that becomes ready during another update', async () => {
        const ledger = new Ledger(), calls: string[] = []; let release: () => void, attempt = 0;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const sites = [{ id: 'verify', Catalog: async function* () { calls.push('verify'); if (++attempt === 1) throw new CatalogVerificationRequired(); yield { items: [{ id: 'v', title: 'V' }], terminal: true, coverage: unknown }; } },
            { id: 'normal-a', Catalog: async function* () { calls.push('normal-a'); await gate; yield { items: [{ id: 'a', title: 'A' }], terminal: true, coverage: unknown }; } },
            { ...source('normal-b'), Catalog: async function* () { calls.push('normal-b'); yield { items: [{ id: 'b', title: 'B' }], terminal: true, coverage: unknown }; } }];
        const run = manager(ledger, sites); await run.Start(); await wait(() => calls.includes('normal-a')); await ledger.VerificationReady('verify');
        expect(calls).toEqual(['verify', 'normal-a']); release(); await wait(() => !run.Activity.Value.owned);
        expect(calls).toEqual(['verify', 'normal-a', 'normal-b', 'verify']); expect(ledger.job?.state).toBe('finished');
    });
    it('Should retain validated earlier 200 observations after a later 521 without claiming a complete index', async () => {
        const ledger = new Ledger(); let observe: (count: number, status?: number) => void;
        const native: CatalogSource = { id: 'partial', ObserveProgress(listener) { observe = listener; return () => {}; }, Catalog: async function* () {
            observe(50, 200); yield { items: [{ id: 'valid', title: 'Valid manga' }], terminal: false, coverage: unknown, httpStatus: 200 };
            observe(0, 521); throw new Error('HTTP 521');
        } };
        const run = manager(ledger, [native, source('next')]); await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.published.mock.calls[0]).toMatchObject(['partial', [{ id: 'valid', title: 'Valid manga' }], { state: 'partial' }]);
        expect(ledger.job?.items.map(item => item.state)).toEqual(['review', 'succeeded']);
        expect(ledger.job?.items[0].attempts).toBe(1);
    });
    it('Should distinguish the internal FetchWindow timeout from the manager deadline without blind retries', async () => {
        const ledger = new Ledger(), native = source('window');
        native.Catalog = async function* () { throw Object.assign(new Error('Internal timeout'), { name: 'Exception<FetchProvider_FetchWindow_TimeoutError>' }); };
        const run = manager(ledger, [native, source('next')]); await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.sites.get('window')?.error).toBe('catalog-window-timeout');
        expect(ledger.job?.items[0].attempts).toBe(1); expect(ledger.job?.items[1].state).toBe('succeeded');
    });
    it('Should not publish links from a rate-limit response or retry it aggressively', async () => {
        const ledger = new Ledger(); let observe: (count: number, status?: number) => void;
        const native: CatalogSource = { id: 'blocked', ObserveProgress(listener) { observe = listener; return () => {}; }, Catalog: async function* () {
            observe(0, 429); yield { items: [{ id: 'error-page-link', title: 'Must not publish' }], terminal: true, coverage: unknown };
        } };
        const run = manager(ledger, [native]); await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.published).not.toHaveBeenCalled(); expect(ledger.job?.items[0]).toMatchObject({ state: 'review', attempts: 1 });
    });
    it('Should publish and finish even when diagnostic logging is unavailable', async () => {
        const ledger = new Ledger();
        const run = new SiteIndexManager(ledger as unknown as SiteIndexRepository, () => [source('a')], lock(), { timeoutMs: 1000, delayMs: 1, retryMs: 1 }, async () => { throw new Error('Log disk unavailable'); });
        await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.published).toHaveBeenCalledOnce(); expect(ledger.job?.state).toBe('finished');
    });
    it('Should extend an idle deadline only for real connector progress', async () => {
        vi.useFakeTimers();
        try {
            const ledger = new Ledger(); let progress: (count: number) => void;
            const native: CatalogSource = { id: 'large', ObserveProgress(listener) { progress = listener; return () => {}; }, Catalog: async function* () {
                for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 10)); progress(100); }
                yield { items: [{ id: 'm', title: 'M' }], terminal: true, coverage: unknown };
            } };
            const run = manager(ledger, [native], lock(), 30);
            await run.Start(); await vi.advanceTimersByTimeAsync(200);
            expect(ledger.published).toHaveBeenCalledOnce();
        } finally { vi.useRealTimers(); }
    });
    it('Should update only one explicitly selected original source without fetching other sites', async () => {
        const ledger = new Ledger(), a = source('a'), b = source('b');
        a.Catalog = vi.fn(a.Catalog); b.Catalog = vi.fn(b.Catalog);
        const run = manager(ledger, [a, b]); await run.Start('b'); await wait(() => !run.Activity.Value.owned);
        expect(a.Catalog).not.toHaveBeenCalled(); expect(b.Catalog).toHaveBeenCalledOnce();
        expect(ledger.job!.items.map(item => item.siteId)).toEqual(['b']);
    });
    it('Should publish valid native entries past the first 100 despite one missing title in a 399-entry catalog', async () => {
        const ledger = new Ledger();
        const entries = Array.from({ length: 399 }, (_, n) => ({ id: String(n), title: n === 100 ? '' : `Manga ${n}` }));
        const run = manager(ledger, [{ id: 'a', Catalog: async function* () {
            for (let offset = 0; offset < entries.length; offset += 50) yield { items: entries.slice(offset, offset + 50), terminal: offset + 50 >= entries.length, coverage: unknown };
        } }]);
        await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.published).toHaveBeenCalledOnce();
        expect(ledger.published.mock.calls[0][1]).toHaveLength(398);
        expect(ledger.published.mock.calls[0][2].state).toBe('partial');
    });
    it('Should honor cancellation requested immediately during startup without invoking a connector', async () => {
        const ledger = new Ledger(), native = source('a'); native.Catalog = vi.fn(native.Catalog);
        const run = manager(ledger, [native]);
        const started = run.Start(); await run.Stop(true); await started; await wait(() => !run.Activity.Value.owned);
        expect(native.Catalog).not.toHaveBeenCalled(); expect(ledger.job!.state).toBe('cancelled');
    });
    it('Should coalesce view initialization and never auto-start a catalog', async () => {
        const ledger = new Ledger(), native = source('a'); native.Catalog = vi.fn(native.Catalog);
        const run = manager(ledger, [native]); const first = run.Initialize(), second = run.Initialize();
        expect(first).toBe(second); await first;
        expect(native.Catalog).not.toHaveBeenCalled(); expect(ledger.job).toBeNull();
    });
    it('Should classify publication storage failure without repeating the source fetch and continue safely', async () => {
        const ledger = new Ledger(); const publish = ledger.Publish.bind(ledger);
        ledger.Publish = async (attempt, entries, coverage) => { if (attempt.siteId === 'bad') throw new IndexStorageError('Injected transaction failure'); await publish(attempt, entries, coverage); };
        const bad = source('bad'); bad.Catalog = vi.fn(bad.Catalog);
        const run = manager(ledger, [bad, source('good')]); await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(bad.Catalog).toHaveBeenCalledOnce(); expect(ledger.sites.get('bad')!.error).toBe('catalog-storage-failed');
        expect(ledger.job!.items.map(item => item.state)).toEqual(['failed', 'succeeded']);
    });
    it('Should yield on endlessly empty source pages so deadlines and cancellation remain responsive', async () => {
        const ledger = new Ledger();
        const run = manager(ledger, [{ id: 'empty', Catalog: async function* () { while (true) yield { items: [], terminal: false, coverage: unknown }; } }], lock(), 20);
        await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.job!.items[0]).toMatchObject({ state: 'failed', attempts: 2 });
        expect(ledger.published).not.toHaveBeenCalled();
    });
    it('Should settle a synchronous iterator failure and continue after its bounded retries', async () => {
        const ledger = new Ledger();
        const broken: CatalogSource = { id: 'broken', Catalog: () => ({ [Symbol.asyncIterator]: () => ({ next() { throw new Error('Synchronous connector failure'); } }) }) };
        const run = manager(ledger, [broken, source('good')]); await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.job!.items[0]).toMatchObject({ state: 'failed', attempts: 2 });
        expect(ledger.published.mock.calls.map(call => call[0])).toEqual(['good']);
    });
    it('Should continue past a failing middle site with two attempts and no raw errors in stored diagnostics', async () => {
        const ledger = new Ledger(), calls: string[] = [];
        const sources = ['a', 'b', 'c'].map(id => ({ id, Catalog: async function* () {
            calls.push(id); if (id === 'b') throw new Error('Network failed https://private.invalid/?token=secret');
            yield { items: [{ id, title: id }], terminal: true, coverage: unknown };
        } }));
        const run = manager(ledger, sources); await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(calls).toEqual(['a', 'b', 'b', 'c']);
        expect(ledger.job!.state).toBe('finished');
        expect(ledger.job!.items.map(item => item.state)).toEqual(['succeeded', 'failed', 'succeeded']);
        expect(ledger.sites.get('b')!.error).toBe('catalog-fetch-or-storage-failed');
    });
    it('Should publish unknown coverage even when the legacy catalog returned successfully', async () => {
        const ledger = new Ledger(), run = manager(ledger, [source('a')]);
        await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.published.mock.calls[0][2]).toEqual(unknown);
    });
    it('Should downgrade complete claims when enumeration ends without terminal evidence', async () => {
        const ledger = new Ledger(), run = manager(ledger, [{ id: 'a', Catalog: async function* () { yield { items: [{ id: 'm', title: 'M' }], terminal: false, coverage: { state: 'complete', evidence: 'Not terminal' } }; } }]);
        await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.published.mock.calls[0][2].state).toBe('unknown');
    });
    it('Should publish useful partial observations with explicit uncertain coverage', async () => {
        const ledger = new Ledger(), run = manager(ledger, [{ id: 'a', Catalog: async function* () { yield { items: [{ id: 'm', title: 'M' }], terminal: true, coverage: { state: 'partial', evidence: 'Only one source page' } }; } }, source('b')]);
        await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.job!.items[0].state).toBe('succeeded');
        expect(ledger.published.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
        expect(ledger.published.mock.calls[0][2].state).toBe('partial');
    });
    it('Should hold the shared lock after a timeout until an uncooperative request settles', async () => {
        const ledger = new Ledger(), mutex = lock(); let release: () => void;
        const late = new Promise<void>(resolve => { release = resolve; });
        const slow: CatalogSource = { id: 'slow', Catalog: async function* () { await late; yield { items: [{ id: 'late', title: 'Late' }], terminal: true, coverage: unknown }; } };
        const run = manager(ledger, [slow, source('next')], mutex, 20);
        await run.Start(); await wait(() => run.Activity.Value.draining);
        expect(ledger.job!.state).toBe('paused');
        expect(ledger.job!.items[0].attempts).toBe(1);
        await expect(manager(ledger, [source('other')], mutex).Start()).rejects.toBeInstanceOf(IndexConflictError);
        expect(ledger.published).not.toHaveBeenCalled(); release!();
        await wait(() => !run.Activity.Value.owned);
        expect(ledger.published.mock.calls.map(call => call[0])).toEqual(['slow', 'next']);
        expect(ledger.job!.items[0].attempts).toBe(2);
    });
    it('Should not auto-resume after the user pauses a timed-out request and must preserve the real timeout charge', async () => {
        const ledger = new Ledger(); let release: () => void;
        const late = new Promise<void>(resolve => { release = resolve; });
        const run = manager(ledger, [{ id: 'slow', Catalog: async function* () { await late; yield { items: [{ id: 'm', title: 'M' }], terminal: true, coverage: unknown }; } }], lock(), 20);
        await run.Start(); await wait(() => run.Activity.Value.draining); await run.Stop();
        release!(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.job!.state).toBe('paused'); expect(ledger.job!.items[0].attempts).toBe(1);
        expect(ledger.published).not.toHaveBeenCalled();
    });
    it('Should pause without spending a failed attempt and resume without repeating a previously published site', async () => {
        const ledger = new Ledger(), a = source('a'); let run: SiteIndexManager;
        a.Published = () => { void run.Stop(); };
        run = manager(ledger, [a, source('b')]);
        await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.job!.items.map(item => item.state)).toEqual(['succeeded', 'queued']);
        await run.Resume(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.published.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
    });
    it('Should cancel an owned request promptly, discard its late result and leave other sites unstarted', async () => {
        const ledger = new Ledger(); let release: () => void;
        const late = new Promise<void>(resolve => { release = resolve; });
        const run = manager(ledger, [{ id: 'slow', Catalog: async function* () { await late; yield { items: [{ id: 'm', title: 'M' }], terminal: true, coverage: unknown }; } }, source('next')]);
        await run.Start(); await wait(() => ledger.job!.current === 'slow'); await run.Stop(true);
        expect(ledger.job!.state).toBe('cancelled'); expect(ledger.published).not.toHaveBeenCalled();
        release!(); await wait(() => !run.Activity.Value.owned); expect(ledger.published).not.toHaveBeenCalled();
    });
    it('Should initialize an interrupted job without auto-starting and preserve previous successes on resume', async () => {
        const ledger = new Ledger(); const job = await ledger.Start(['a', 'b']); job.items[0].state = 'succeeded'; job.items[1] = { siteId: 'b', state: 'updating', attempts: 1 };
        const run = manager(ledger, [source('a'), source('b')]); await run.Initialize();
        expect(run.State.Value.job!.state).toBe('interrupted'); expect(ledger.published).not.toHaveBeenCalled();
        await run.Resume(); await wait(() => !run.Activity.Value.owned); expect(ledger.published.mock.calls.map(call => call[0])).toEqual(['b']);
    });
    it('Should flag an ambiguous duplicate without discarding other valid observations', async () => {
        const ledger = new Ledger(), run = manager(ledger, [{ id: 'a', Catalog: async function* () { yield { items: [{ id: 'm', title: 'A' }, { id: 'm', title: 'B' }], terminal: true, coverage: unknown }; } }]);
        await run.Start(); await wait(() => !run.Activity.Value.owned); expect(ledger.job!.items[0].state).toBe('succeeded'); expect(ledger.published.mock.calls[0][2].state).toBe('partial');
    });
    it('Should deduplicate identical entries and yield while processing a large catalog', async () => {
        const ledger = new Ledger(); let heartbeat = false;
        const run = manager(ledger, [{ id: 'a', Catalog: async function* () { yield { items: Array.from({ length: 10001 }, (_, i) => ({ id: String(i % 10000), title: String(i % 10000) })), terminal: true, coverage: unknown }; } }]);
        await run.Start(); setTimeout(() => { heartbeat = true; }, 0); await wait(() => !run.Activity.Value.owned);
        expect(heartbeat).toBe(true); expect(ledger.published.mock.calls[0][1]).toHaveLength(10000);
    });
});
