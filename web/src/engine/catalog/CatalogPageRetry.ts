/** Retry the same native page only; no cursor advance or completeness inference on transient server failure. */
export async function FetchCatalogPage<T>(fetch: () => Promise<T>, status: () => number | undefined, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try { const value = await fetch(); if ([502, 503, 504, 521].includes(status() ?? 0)) throw new Error(`HTTP ${status()} catalog page`); return value; }
        catch(error) {
            if (attempt >= 2 || ![502, 503, 504, 521].includes(status() ?? 0)) throw error;
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => signal?.removeEventListener('abort', abort);
                const timer = setTimeout(() => { cleanup(); resolve(); }, 1000 * 2 ** attempt);
                const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
                signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
            });
        }
    }
}
