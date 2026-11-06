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
    async Publish(attempt: IndexAttempt, entries: CatalogEntry[], coverage: CatalogCoverage) {
        this.published(attempt.siteId, entries, coverage); this.job!.items.find(item => item.siteId === attempt.siteId)!.state = 'succeeded';
        Object.assign(this.sites.get(attempt.siteId)!, { state: 'succeeded', count: entries.length, coverage }); this.job!.current = null;
    }
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
    it('Should retain partial observations for review without publishing them', async () => {
        const ledger = new Ledger(), run = manager(ledger, [{ id: 'a', Catalog: async function* () { yield { items: [{ id: 'm', title: 'M' }], terminal: true, coverage: { state: 'partial', evidence: 'Only one source page' } }; } }, source('b')]);
        await run.Start(); await wait(() => !run.Activity.Value.owned);
        expect(ledger.job!.items[0].state).toBe('review');
        expect(ledger.published.mock.calls.map(call => call[0])).toEqual(['b']);
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
    it('Should reject conflicting duplicate identities instead of silently dropping one variant', async () => {
        const ledger = new Ledger(), run = manager(ledger, [{ id: 'a', Catalog: async function* () { yield { items: [{ id: 'm', title: 'A' }, { id: 'm', title: 'B' }], terminal: true, coverage: unknown }; } }]);
        await run.Start(); await wait(() => !run.Activity.Value.owned); expect(ledger.job!.items[0].state).toBe('review'); expect(ledger.published).not.toHaveBeenCalled();
    });
    it('Should deduplicate identical entries and yield while processing a large catalog', async () => {
        const ledger = new Ledger(); let heartbeat = false;
        const run = manager(ledger, [{ id: 'a', Catalog: async function* () { yield { items: Array.from({ length: 10001 }, (_, i) => ({ id: String(i % 10000), title: String(i % 10000) })), terminal: true, coverage: unknown }; } }]);
        await run.Start(); setTimeout(() => { heartbeat = true; }, 0); await wait(() => !run.Activity.Value.owned);
        expect(heartbeat).toBe(true); expect(ledger.published.mock.calls[0][1]).toHaveLength(10000);
    });
});
