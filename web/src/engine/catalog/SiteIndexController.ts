import { MangaPlugin } from '../providers/MangaPlugin';
import { EngineArchiveSource } from '../archive/ArchiveSource';
import { Tags } from '../Tags';
import { SiteIndexRepository } from './SiteIndexRepository';
import { SiteIndexManager } from './SiteIndexManager';
import type { IndexSiteState, IndexJob } from './SiteIndexContract';

export const IndexStateLabel: Record<IndexSiteState, string> = { queued: 'Queued', updating: 'Updating', succeeded: 'Catalog saved',
    failed: 'Update failed', stale: 'Older catalog retained', cancelled: 'Cancelled', review: 'Needs review' };
export const IndexJobStateLabel: Record<IndexJob['state'], string> = { running: 'Updating', paused: 'Paused', interrupted: 'Interrupted', cancelled: 'Cancelled', finished: 'Selected updates finished' };
export function IndexErrorLabel(code: string): string {
    if (code.startsWith('catalog-needs-review')) return 'No usable observation or an ambiguous result. The previous catalog is safe.';
    if (code.startsWith('catalog-conflict')) return 'A newer catalog or job state was preserved.';
    if (code.startsWith('catalog-timeout')) return 'Catalog request timed out. Late results were not published.';
    if (code.startsWith('catalog-storage')) return 'Cannot save the catalog. Previously saved entries remain available.';
    if (code.startsWith('catalog-access')) return 'Access or indexing capability is unavailable. No protection bypass is attempted.';
    if (code.startsWith('catalog-interrupted') || code.startsWith('interrupted:')) return 'Previous update was interrupted. Resume explicitly within the saved retry budget.';
    return 'Cannot fetch or read this catalog. Previously saved entries are retained.';
}
export function ArabicCatalogSources(sites: readonly unknown[]) {
    return sites.filter((site): site is MangaPlugin => site instanceof MangaPlugin && site.Tags.Value.some(tag => tag.Category === Tags.Language.Arabic.Category && tag.Title === Tags.Language.Arabic.Title))
        .map(site => ({ id: site.Identifier, Catalog: (signal: AbortSignal) => new EngineArchiveSource(site).Catalog(signal), Published: () => site.InvalidateMediaListCache() }));
}
let controller: SiteIndexManager | undefined;
export function GetSiteIndexController(): SiteIndexManager {
    return controller ??= new SiteIndexManager(new SiteIndexRepository(), () => ArabicCatalogSources(HakuNeko.PluginController.WebsitePlugins), navigator.locks);
}
