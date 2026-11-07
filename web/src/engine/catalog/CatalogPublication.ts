import { IndexReviewError, type CatalogEntry, type CatalogCoverage } from './SiteIndexContract';
/** Search observations are useful without a complete-source proof. Absence is never a deletion instruction. */
export function MergeCatalogObservation(previous: CatalogEntry[], incoming: CatalogEntry[], coverage: CatalogCoverage) {
    const previousById = new Map(previous.map(entry => [entry.id, entry]));
    incoming = incoming.map(entry => previousById.get(entry.id)?.aliases?.length ? { ...entry, aliases: previousById.get(entry.id).aliases } : entry);
    if (coverage.state === 'unsupported' || !incoming.length && coverage.state !== 'complete' || coverage.state === 'complete' && !coverage.evidence.trim()) throw new IndexReviewError('No usable catalog observation');
    const ids = new Set(incoming.map(entry => entry.id));
    const retained = coverage.state === 'complete' ? [] : previous.filter(entry => !ids.has(entry.id));
    const comparison = { added: 0, changed: 0, unchanged: 0, retained: retained.length };
    for (const entry of incoming) {
        const old = previousById.get(entry.id);
        if (!old) comparison.added++; else if (old.title !== entry.title) comparison.changed++; else comparison.unchanged++;
    }
    return { entries: [...incoming, ...retained], coverage: retained.length ? { state: 'partial' as const, evidence: 'New observations merged with retained cached identities; source completeness unproven' } : coverage, comparison };
}
