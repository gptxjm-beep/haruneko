import { NotifyCatalogChange } from './CatalogNotifications';
import { MergeCatalogObservation } from './CatalogPublication';
import { Store } from '../StorageController';
import { OpenMediaDatabase } from './MediaDatabase';
import { EmptyIndexSite, IndexConflictError, IndexReviewError, IndexStorageError, type CatalogEntry, type CatalogCoverage, type IndexSite, type IndexJob, type IndexSnapshot, type IndexAttempt } from './SiteIndexContract';

const meta = 'SiteIndexMetadata', jobs = 'SiteIndexJob', staging = 'SiteIndexStaging';
const RequestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
async function Transaction<T>(stores: string[], action: (transaction: IDBTransaction) => Promise<T>, mode: IDBTransactionMode = 'readwrite'): Promise<T> {
    const db = await OpenMediaDatabase();
    const tx = db.transaction(stores, mode);
    const completed = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Catalog transaction aborted')); });
    try { const value = await action(tx); await completed; return value; }
    catch(error) { try { tx.abort(); } catch { /* Transaction already ended. */ } await completed.catch(() => {});
        if (error instanceof IndexConflictError || error instanceof IndexReviewError) throw error;
        throw new IndexStorageError('Catalog storage transaction failed', { cause: error }); }
    finally { db.close(); }
}
async function Site(tx: IDBTransaction, siteId: string): Promise<IndexSite> {
    const existing = await RequestValue<IndexSite>(tx.objectStore(meta).get(siteId));
    if (existing) return existing;
    const legacy = await RequestValue<CatalogEntry[]>(tx.objectStore(Store.MediaLists).get(siteId));
    return { ...EmptyIndexSite(siteId), count: Array.isArray(legacy) ? legacy.length : 0, state: legacy?.length ? 'stale' : 'queued' };
}
async function Job(tx: IDBTransaction, id?: string): Promise<IndexJob> {
    const value = await RequestValue<IndexJob>(tx.objectStore(jobs).get('arabic-sites'));
    if (!value || id && value.id !== id) throw new IndexConflictError('The catalog job has changed');
    return value;
}
/** Legacy manual refresh remains explicit. Track its revision so an older bulk candidate cannot overwrite it. */
export async function SaveManualMediaList(siteId: string, entries: unknown): Promise<void> {
    await Transaction([Store.MediaLists, meta], async tx => {
        const previous = await Site(tx, siteId);
        if (Array.isArray(entries)) {
            const old = await RequestValue<CatalogEntry[]>(tx.objectStore(Store.MediaLists).get(siteId));
            const aliases = new Map((Array.isArray(old) ? old : []).filter(entry => entry?.aliases?.length).map(entry => [entry.id, entry.aliases]));
            entries = entries.map(entry => entry?.id && aliases.has(entry.id) ? { ...entry, aliases: aliases.get(entry.id) } : entry);
        }
        tx.objectStore(Store.MediaLists).put(entries, siteId);
        tx.objectStore(meta).put({ ...previous, revision: previous.revision + 1, count: Array.isArray(entries) ? entries.length : 0,
            state: 'review', lastSuccess: Array.isArray(entries) ? Date.now() : previous.lastSuccess, lastAttempt: Date.now(), error: null, coverage: { state: 'unknown', evidence: 'Explicit legacy manual refresh; completeness unproven' } });
    });
    NotifyCatalogChange(siteId);
}

/** One accepted list in MediaLists. Candidate batches never become visible before the atomic publication. */
export async function SaveCatalogAliases(siteId: string, mangaId: string, aliases: string[]): Promise<void> {
    const safe = [...new Set(aliases.filter(alias => typeof alias === 'string' && alias.trim()).map(alias => alias.slice(0, 1024)))].slice(0, 30);
    if (!safe.length) return;
    await Transaction([Store.MediaLists, meta], async tx => {
        const entries = await RequestValue<CatalogEntry[]>(tx.objectStore(Store.MediaLists).get(siteId));
        const row = entries?.find(entry => entry.id === mangaId); if (!row) return;
        const next = [...new Set([...row.aliases ?? [], ...safe])].slice(0, 30);
        if (JSON.stringify(row.aliases) === JSON.stringify(next)) return;
        row.aliases = next;
        const site = await Site(tx, siteId);
        tx.objectStore(Store.MediaLists).put(entries, siteId); tx.objectStore(meta).put({ ...site, revision: site.revision + 1 });
    });
    NotifyCatalogChange(siteId);
}
export class SiteIndexRepository {
    public async Snapshot(): Promise<IndexSnapshot> {
        return Transaction([jobs, meta], async tx => ({ job: await RequestValue(tx.objectStore(jobs).get('arabic-sites')) ?? null,
            sites: await RequestValue(tx.objectStore(meta).getAll()) }), 'readonly');
    }
    public async Start(siteIds: string[]): Promise<IndexJob> {
        return Transaction([jobs, meta, Store.MediaLists, staging], async tx => {
            const previous = await RequestValue<IndexJob>(tx.objectStore(jobs).get('arabic-sites'));
            if (previous && !['finished', 'cancelled'].includes(previous.state)) throw new IndexConflictError('Resume or cancel the existing catalog job first');
            const ids = [...new Set(siteIds)];
            if (!ids.length || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !id.length || id.length > 512)) throw new Error('Invalid site selection');
            const job: IndexJob = { key: 'arabic-sites', id: crypto.randomUUID(), state: 'running', items: ids.map(siteId => ({ siteId, state: 'queued', attempts: 0 })), current: null, updatedAt: Date.now() };
            for (const siteId of ids) { const value = await Site(tx, siteId); tx.objectStore(meta).put({ ...value, state: 'queued' }); }
            tx.objectStore(staging).clear(); tx.objectStore(jobs).put(job); return job;
        });
    }
    public async Resume(): Promise<IndexJob> {
        return Transaction([jobs, meta, Store.MediaLists, staging], async tx => {
            const job = await Job(tx);
            if (!['paused', 'interrupted', 'running'].includes(job.state)) throw new IndexConflictError('This catalog job cannot resume');
            for (const item of job.items) if (item.state === 'updating') {
                item.state = item.attempts >= 2 ? 'review' : 'queued';
                const site = await Site(tx, item.siteId);
                tx.objectStore(meta).put({ ...site, state: item.state, error: 'interrupted: previous attempt did not publish a catalog' });
            }
            job.state = 'running'; job.current = null; job.updatedAt = Date.now();
            tx.objectStore(staging).clear(); tx.objectStore(jobs).put(job); return job;
        });
    }
    public async Interrupt(): Promise<void> {
        await Transaction([jobs, meta, Store.MediaLists], async tx => {
            const job = await RequestValue<IndexJob>(tx.objectStore(jobs).get('arabic-sites'));
            if (job?.state !== 'running') return;
            job.state = 'interrupted'; job.updatedAt = Date.now();
            for (const item of job.items) if (item.state === 'updating') {
                const site = await Site(tx, item.siteId);
                tx.objectStore(meta).put({ ...site, state: 'review', error: 'catalog-interrupted: resume explicitly to reconcile the attempt budget' });
            }
            tx.objectStore(jobs).put(job);
        });
    }
    public async Begin(jobId: string, siteId: string): Promise<IndexAttempt> {
        return Transaction([jobs, meta, Store.MediaLists], async tx => {
            const job = await Job(tx, jobId), item = job.items.find(item => item.siteId === siteId);
            if (job.state !== 'running' || !item || item.attempts >= 2 || item.state !== 'queued') throw new IndexConflictError('Site attempt is unavailable');
            const site = await Site(tx, siteId);
            item.state = 'updating'; item.attempts++; job.current = siteId; job.updatedAt = Date.now();
            tx.objectStore(jobs).put(job); tx.objectStore(meta).put({ ...site, state: 'updating', lastAttempt: Date.now(), discovered: null, error: null });
            return { jobId, siteId, id: crypto.randomUUID(), revision: site.revision };
        });
    }
    public async Stage(attempt: IndexAttempt, offset: number, entries: readonly CatalogEntry[]): Promise<void> {
        await Transaction([jobs, meta, staging], async tx => {
            const job = await Job(tx, attempt.jobId);
            if (job.state !== 'running' || job.current !== attempt.siteId) throw new IndexConflictError('Attempt stopped');
            if (!Number.isSafeInteger(offset) || offset < 0 || entries.length > 500) throw new Error('Invalid catalog batch');
            tx.objectStore(staging).put({ attemptId: attempt.id, offset, entries });
            const site = await RequestValue<IndexSite>(tx.objectStore(meta).get(attempt.siteId));
            tx.objectStore(meta).put({ ...site, discovered: offset + entries.length });
        });
    }
    public async Candidate(attempt: IndexAttempt): Promise<CatalogEntry[]> {
        const result: CatalogEntry[] = [];
        // Read bounded batches; yield between them. Only the final legacy array needs to be materialized.
        let after = -1;
        while (true) {
            const batch = await Transaction([staging], async tx => RequestValue(tx.objectStore(staging).openCursor(IDBKeyRange.bound([attempt.id, after + 1], [attempt.id, Number.MAX_SAFE_INTEGER]))), 'readonly');
            if (!batch) break;
            if (batch.value.offset !== result.length) throw new IndexReviewError('Candidate batches are incomplete');
            result.push(...batch.value.entries); after = batch.value.offset;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        return result;
    }
    public async Publish(attempt: IndexAttempt, entries: CatalogEntry[], coverage: CatalogCoverage): Promise<void> {
        await Transaction([jobs, meta, Store.MediaLists, staging], async tx => {
            const job = await Job(tx, attempt.jobId), site = await Site(tx, attempt.siteId);
            if (job.state !== 'running' || job.current !== attempt.siteId || site.revision !== attempt.revision) throw new IndexConflictError('Manual refresh or job state changed; candidate not published');
            const old = await RequestValue<CatalogEntry[]>(tx.objectStore(Store.MediaLists).get(site.siteId));
            if (entries.length !== site.discovered) throw new IndexReviewError('Incomplete staging transaction; previous index retained');
            const merged = MergeCatalogObservation(old ?? [], entries, coverage);
            job.items.find(item => item.siteId === site.siteId)!.state = 'succeeded'; job.current = null; job.updatedAt = Date.now();
            tx.objectStore(Store.MediaLists).put(merged.entries, site.siteId);
            tx.objectStore(meta).put({ ...site, revision: site.revision + 1, count: merged.entries.length, lastSuccess: Date.now(), discovered: entries.length, state: 'succeeded', error: null, coverage: merged.coverage, comparison: merged.comparison });
            tx.objectStore(jobs).put(job);
            tx.objectStore(staging).delete(IDBKeyRange.bound([attempt.id, 0], [attempt.id, Number.MAX_SAFE_INTEGER]));
        });
        NotifyCatalogChange(attempt.siteId);
    }
    public async Result(attempt: IndexAttempt, error: string, review: boolean, retry: boolean): Promise<void> {
        await Transaction([jobs, meta, Store.MediaLists, staging], async tx => {
            const job = await Job(tx, attempt.jobId);
            if (job.state !== 'running' || job.current !== attempt.siteId) return;
            const site = await Site(tx, attempt.siteId), item = job.items.find(item => item.siteId === site.siteId)!;
            item.state = retry && item.attempts < 2 ? 'queued' : review ? 'review' : site.count ? 'stale' : 'failed';
            job.current = null; job.updatedAt = Date.now();
            tx.objectStore(meta).put({ ...site, state: item.state, error }); tx.objectStore(jobs).put(job);
            tx.objectStore(staging).delete(IDBKeyRange.bound([attempt.id, 0], [attempt.id, Number.MAX_SAFE_INTEGER]));
        });
        NotifyCatalogChange(attempt.siteId);
    }
    public async State(id: string, state: IndexJob['state']): Promise<void> {
        await Transaction([jobs, meta, Store.MediaLists, staging], async tx => {
            const job = await Job(tx, id);
            if (job.state === 'cancelled') return;
            job.state = state; job.current = null; job.updatedAt = Date.now();
            if (state === 'paused' || state === 'cancelled') for (const item of job.items) if (['queued', 'updating'].includes(item.state)) {
                if (item.state === 'updating') item.attempts = Math.max(0, item.attempts - 1); // User stop is not a connector failure.
                item.state = state === 'cancelled' ? 'cancelled' : 'queued';
                const site = await Site(tx, item.siteId); tx.objectStore(meta).put({ ...site, state: item.state });
            }
            tx.objectStore(staging).clear(); tx.objectStore(jobs).put(job);
        });
        NotifyCatalogChange();
    }
}
