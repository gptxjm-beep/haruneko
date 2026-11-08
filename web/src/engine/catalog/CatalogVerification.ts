import type { IRemoteBrowserWindow } from '../platform/RemoteBrowserWindow';
import { CheckAntiScrapingDetection, FetchRedirection } from '../platform/AntiScrapingDetection';
interface Context { signal: AbortSignal; required: () => void; blocked: () => void; cleared?: () => void; }
const contexts = new Map<string, Context>();
const requests = new WeakMap<Request, Context>();
const observers = new Map<string, Set<(state: 'required' | 'blocked' | 'cleared') => void>>();
export class CatalogVerificationRequired extends Error { constructor() { super('Verification required; the owned fetch window was closed'); this.name = 'CatalogVerificationRequired'; } }
export function ObserveCatalogVerification(origin: string, listener: (state: 'required' | 'blocked' | 'cleared') => void): () => void {
    const set = observers.get(origin) ?? new Set(); observers.set(origin, set); set.add(listener); return () => { set.delete(listener); if (!set.size) observers.delete(origin); };
}
export function OwnCatalogWindows(origin: string, signal: AbortSignal): () => void {
    if (contexts.has(origin)) throw new Error('Catalog windows for this source are already owned');
    const context = { signal, required: () => { for (const listener of observers.get(origin) ?? []) listener('required'); }, blocked: () => { for (const listener of observers.get(origin) ?? []) listener('blocked'); }, cleared: () => { for (const listener of observers.get(origin) ?? []) listener('cleared'); } };
    contexts.set(origin, context); return () => { if (contexts.get(origin) === context) contexts.delete(origin); };
}
export function BindCatalogWindow(request: Request, owner?: AbortSignal): Request {
    const context = contexts.get(new URL(request.url).origin);
    if (owner && context?.signal === owner) requests.set(request, context);
    return request;
}
export const CatalogWindowContext = (request: Request) => requests.get(request);
/** Catalog-only manual verification. User waiting has no deadline; cancellation still owns window cleanup. */
export function FetchManagedCatalogWindow<T extends void | JSONElement>(win: IRemoteBrowserWindow, request: Request, script: string, preload: string, delay: number, timeout: number, context: Context,
    detect = CheckAntiScrapingDetection): Promise<T> {
    context.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        let polling: ReturnType<typeof setInterval>;
        let settled = false, closing = false, checking = false, detected = false;
        let timer = setTimeout(() => { void finish(new DOMException('Catalog window timed out', 'TimeoutError')); }, timeout);
        const finish = async (error?: unknown, value?: T) => {
            if (closing || settled) return; closing = true; clearTimeout(timer); clearInterval(polling);
            try { await win.Close(); }
            catch { context.blocked(); return; } // Keep the transport pending: no unsafe next-site overlap.
            settled = true; context.signal.removeEventListener('abort', abort); win.DOMReady.Unsubscribe(ready);
            error ? reject(error) : resolve(value as T);
        };
        const abort = () => { void finish(context.signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
        const ready = async () => {
            if (checking || closing || settled) return; checking = true;
            try {
                if (!await win.ExecuteScript<boolean>("location.protocol === 'https:' || location.protocol === 'http:'")) return;
                const mode = await detect(win, request.url);
                if (closing || settled) return;
                if (mode === FetchRedirection.Interactive) {
                    if (!detected) { detected = true; polling = setInterval(() => { void ready(); }, 1000); context.required(); clearTimeout(timer); }
                    await win.Show(); return;
                }
                if (mode === FetchRedirection.Automatic) return;
                if (detected) { detected = false; clearInterval(polling); context.cleared?.(); }
                await new Promise(done => setTimeout(done, delay));
                if (!closing) await finish(undefined, await win.ExecuteScript<T>(script));
            } catch(error) { await finish(error); } finally { checking = false; }
        };
        win.DOMReady.Subscribe(ready); context.signal.addEventListener('abort', abort, { once: true });
        void win.Open(request, false, preload).catch(error => finish(error));
        if (context.signal.aborted) abort();
    });
}
