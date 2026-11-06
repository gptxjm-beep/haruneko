import type { SearchParameters, SearchSite, SearchResult } from './LocalSearch';
export class SearchWorkerClient {
    private worker: Worker | undefined;
    private nextId = 0;
    private searchId: number | undefined;
    private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
    private Ensure(): Worker {
        if (!this.worker) {
            this.worker = new Worker(new URL('./LocalSearch.worker.ts', import.meta.url), { type: 'module' });
            this.worker.onmessage = event => {
                const { id, result, error } = event.data, operation = this.pending.get(id);
                if (!operation) return;
                this.pending.delete(id);
                if (error) operation.reject(new Error(error)); else operation.resolve(result);
            };
            this.worker.onerror = () => { this.Close(new Error('search-unavailable')); };
        }
        return this.worker;
    }
    private Request<T>(data: object): Promise<T> {
        const id = ++this.nextId;
        return new Promise<T>((resolve, reject) => { this.pending.set(id, { resolve, reject }); try { this.Ensure().postMessage({ ...data, id }); } catch(error) { this.pending.delete(id); reject(error); } });
    }
    public Search(parameters: SearchParameters, sites: SearchSite[]): Promise<SearchResult> {
        this.Cancel();
        const operation = this.Request<SearchResult>({ operation: 'search', parameters, sites }); this.searchId = this.nextId;
        return operation;
    }
    public Find(siteId: string, mangaId: string): Promise<{ id: string; title: string } | null> { return this.Request({ operation: 'find', siteId, mangaId }); }
    public Cancel(): void {
        if (this.searchId !== undefined) { this.pending.get(this.searchId)?.reject(new DOMException('Search superseded', 'AbortError')); this.pending.delete(this.searchId); }
        this.searchId = undefined;
        this.worker?.postMessage({ operation: 'cancel', id: ++this.nextId });
    }
    public Close(error: unknown = new DOMException('Search worker closed', 'AbortError')): void {
        this.worker?.terminate(); this.worker = undefined;
        for (const operation of this.pending.values()) operation.reject(error);
        this.pending.clear(); this.searchId = undefined;
    }
}
