// Test-only transport: responses are synthetic local data. Unknown routes throw; no external fetch or session access occurs.
import { FetchProvider } from '/src/engine/platform/FetchProviderCommon.ts';
import { RecordDiagnosticResponse } from '/src/engine/ImageDiagnostics.ts';
import { RecordCatalogHTTP } from '/src/engine/catalog/CatalogNetwork.ts';
const routes = new Map();
const requests = [];
export function Respond(url, response) { routes.set(url, response); }
export function Requests() { return [...requests]; }
class LocalProvider extends FetchProvider {
    async Fetch(request) {
        request.signal.throwIfAborted();
        const route = routes.get(request.url);
        if (!route) throw new Error('No isolated connector fixture for this request');
        const url = new URL(request.url);
        const referer = request.headers.get('X-FetchAPI-Referer') ?? request.headers.get('Referer');
        requests.push({ host: url.host, path: url.pathname, method: request.method, referer: referer ? new URL(referer).origin + new URL(referer).pathname : '' });
        if (route.delayMs) await new Promise((resolve, reject) => {
            const end = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
            const abort = () => { end(); reject(request.signal.reason); };
            const timer = setTimeout(() => { end(); resolve(); }, route.delayMs);
            request.signal.addEventListener('abort', abort, { once: true });
            if (request.signal.aborted) abort();
        });
        const body = typeof route.body === 'function' ? await route.body(request) : route.body;
        const response = new Response(body, { status: route.status ?? 200, headers: { 'Content-Type': route.type ?? 'text/html' } });
        Object.defineProperty(response, 'url', { value: route.finalUrl ?? request.url });
        RecordDiagnosticResponse(request, response);
        RecordCatalogHTTP(request, response);
        await this.ValidateResponse(response);
        return response;
    }
}
const provider = new LocalProvider();
export const SetupFetchProvider = () => {};
export const Fetch = request => provider.Fetch(request);
export const FetchHTML = request => provider.FetchHTML(request);
export const FetchCSS = (request, query) => provider.FetchCSS(request, query);
export const FetchJSON = request => provider.FetchJSON(request);
export const FetchRegex = (request, regex) => provider.FetchRegex(request, regex);
export const FetchWindowScript = async () => { /* Fixture initialization never opens a remote window or executes a website script. */ };
export const FetchWindowPreloadScript = FetchWindowScript;
export const FetchGraphQL = (...args) => provider.FetchGraphQL(...args);
export const FetchNextProps = (...args) => provider.FetchNextProps(...args);
export const FetchNextJS = (...args) => provider.FetchNextJS(...args);
export const FetchProto = (...args) => provider.FetchProto(...args);
