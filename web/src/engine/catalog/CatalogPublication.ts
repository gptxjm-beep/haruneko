import { IndexReviewError, type CatalogEntry, type CatalogCoverage } from './SiteIndexContract';
/** Search observations are useful without a complete-source proof. Absence is never a deletion instruction. */
export function MergeCatalogObservation(previous: CatalogEntry[], incoming: CatalogEntry[], coverage: CatalogCoverage): { entries: CatalogEntry[]; coverage: CatalogCoverage } {
    if (coverage.state === 'unsupported' || !incoming.length && coverage.state !== 'complete' || coverage.state === 'complete' && !coverage.evidence.trim()) throw new IndexReviewError('No usable catalog observation');
    if (coverage.state === 'complete') return { entries: incoming, coverage };
    const ids = new Set(incoming.map(entry => entry.id));
    const retained = previous.filter(entry => !ids.has(entry.id));
    return { entries: [...incoming, ...retained], coverage: retained.length ? { state: 'partial', evidence: 'New observations merged with retained cached identities; source completeness unproven' } : coverage };
}
