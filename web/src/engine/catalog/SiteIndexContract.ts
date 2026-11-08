export interface CatalogEntry { id: string; title: string; aliases?: string[]; }
export interface CatalogCoverage { state: 'complete' | 'partial' | 'unknown' | 'unsupported'; evidence: string; }
export type IndexSiteState = 'queued' | 'updating' | 'succeeded' | 'failed' | 'stale' | 'cancelled' | 'review' | 'verification' | 'ready';
export interface IndexSite {
    siteId: string; revision: number; count: number; lastSuccess: number | null; lastAttempt: number | null;
    state: IndexSiteState; error: string | null; coverage: CatalogCoverage; discovered: number | null;
    comparison?: { added: number; changed: number; unchanged: number; retained: number };
}
export interface IndexJobItem { siteId: string; state: IndexSiteState; attempts: number; }
export interface IndexJob {
    key: 'arabic-sites'; id: string; state: 'running' | 'paused' | 'interrupted' | 'cancelled' | 'finished' | 'waiting';
    items: IndexJobItem[]; current: string | null; updatedAt: number;
}
export interface IndexSnapshot { job: IndexJob | null; sites: IndexSite[]; }
export interface IndexAttempt { jobId: string; siteId: string; id: string; revision: number; }
export const UnknownCoverage: CatalogCoverage = { state: 'unknown', evidence: 'Connector supplies no complete-index proof' };
export const EmptyIndexSite = (siteId: string): IndexSite => ({ siteId, revision: 0, count: 0, lastSuccess: null, lastAttempt: null,
    state: 'queued', error: null, coverage: { ...UnknownCoverage }, discovered: null });
export class IndexConflictError extends Error {}
export class IndexReviewError extends Error {}

export class IndexStorageError extends Error {}
