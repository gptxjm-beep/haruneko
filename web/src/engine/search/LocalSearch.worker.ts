import { SearchWorkerEngine, SupersededSearch } from './SearchWorkerEngine';
import { MediaDatabaseBlockedError } from '../catalog/MediaDatabase';
import { ReadSearchSite } from './SearchDatabase';
import type { SearchParameters, SearchSite } from './LocalSearch';
const engine = new SearchWorkerEngine();
self.onmessage = async (event: MessageEvent<{ id: number; operation: 'search' | 'cancel' | 'find' | 'contains' | 'libraries'; parameters?: SearchParameters; sites?: SearchSite[]; siteId?: string; mangaId?: string; references?: { siteId: string; mangaId: string }[] }>) => {
    const { id, parameters, sites, operation, siteId, mangaId } = event.data;
    if (operation === 'cancel') { engine.Cancel(); return; }
    try {
        if (operation === 'libraries') {
            const result: (SearchSite & { count: number; complete: boolean })[] = [];
            for (const site of sites ?? []) {
                const data = await ReadSearchSite(site.id);
                const count = data.entries?.filter(entry => typeof entry?.id === 'string' && !!entry.id.trim() && typeof entry.title === 'string' && !!entry.title.trim()).length ?? 0;
                if (count) result.push({ ...site, count, complete: data.metadata.coverage.state === 'complete' });
            }
            self.postMessage({ id, result });
        } else if (operation === 'contains') {
            const refs = event.data.references ?? [], found = refs.map(() => false);
            for (const source of new Set(refs.map(ref => ref.siteId))) {
                const data = await ReadSearchSite(source), identities = new Set(data.entries?.map(entry => entry.id));
                refs.forEach((ref, n) => { if (ref.siteId === source) found[n] = identities.has(ref.mangaId); });
            }
            self.postMessage({ id, result: found });
        } else if (operation === 'find') { const data = await ReadSearchSite(siteId!); self.postMessage({ id, result: data.entries?.find(entry => entry.id === mangaId) ?? null }); }
        else self.postMessage({ id, result: await engine.Search(parameters!, sites ?? []) });
    } catch(error) { if (!(error instanceof SupersededSearch)) self.postMessage({ id, error: error instanceof MediaDatabaseBlockedError ? 'blocked' : 'search-unavailable' }); }
};
