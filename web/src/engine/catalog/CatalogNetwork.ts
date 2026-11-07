// Request-scoped status observations only; never URLs, headers or response bodies.
const observers = new WeakMap<Request, (status: number) => void>();
export function TraceCatalogRequest(request: Request, observe: (status: number) => void): void { observers.set(request, observe); }
export function RecordCatalogHTTP(request: Request, response: Response): void {
    try { observers.get(request)?.(response.status); } catch { /* Diagnostics never change fetch behavior. */ }
}
