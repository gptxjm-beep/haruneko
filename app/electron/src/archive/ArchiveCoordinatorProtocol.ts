/** Development-only bounds, enforced again in the main process. No unlimited mode. */
export const ArchiveDevelopmentLimits = Object.freeze({ mangas: 5, chapters: 20, catalogPages: 20, pageItems: 100, chaptersPerManga: 200 });
export interface ArchivePolicy {
    maxMangas: number;
    maxChapters: number;
    delayMs: number;
    retryDelayMs: number;
    maxAttempts: number;
    languages: string[];
    unknownLanguage: 'include' | 'review';
}
export type ArchiveRunState = 'running' | 'paused' | 'cancelled' | 'interrupted' | 'limited' | 'review' | 'drained' | 'failed';
export type ArchiveEvidence = { state: 'complete' | 'partial' | 'unknown' | 'unsupported'; evidence: string };
export interface ArchiveMangaRecord { id: string; title: string }
export interface ArchiveWorkChapter {
    id: string; title: string; position: number; language: string | null;
    expectedPages?: number; expectedPagesTrusted?: boolean; expectedPagesEvidence?: string;
}
export interface ArchiveWorkManga extends ArchiveMangaRecord { state: string; admitted: number; listed: number; listings: number; next_retry: number; reason: string }
export interface ArchiveWorkItem extends ArchiveWorkChapter { state: string; attempts: number; chapter_key: string; next_retry: number; reason: string; expected_pages: number | null; expected_trusted: number; pages_evidence: string }
export interface ArchiveRunSnapshot {
    sessionId: string; state: ArchiveRunState; policy: ArchivePolicy; catalogDone: boolean; catalogPages: number;
    index: ArchiveEvidence; mangasUsed: number; chaptersStarted: number; reason: string; catalogAttempts: number;
    counts: Record<string, number>; nextRetry: number | null;
}
export type ArchiveCoordinatorCommand =
    | { operation: 'archive-run-open'; sessionId: string; policy: ArchivePolicy }
    | { operation: 'archive-run-state'; sessionId: string; state: ArchiveRunState; reason: string }
    | { operation: 'archive-run-snapshot'; sessionId: string }
    | { operation: 'archive-catalog-begin'; sessionId: string }
    | { operation: 'archive-catalog-page'; sessionId: string; items: ArchiveMangaRecord[] }
    | { operation: 'archive-catalog-end'; sessionId: string; index: ArchiveEvidence }
    | { operation: 'archive-next-manga'; sessionId: string; now: number }
    | { operation: 'archive-manga-begin'; sessionId: string; mangaId: string }
    | { operation: 'archive-manga-list'; sessionId: string; mangaId: string; chapters: ArchiveWorkChapter[]; order: 'ascending' | 'descending' | 'unknown'; evidence: ArchiveEvidence; orderEvidence: string }
    | { operation: 'archive-manga-defer'; sessionId: string; mangaId: string; reason: string; retryable: boolean }
    | { operation: 'archive-next-chapter'; sessionId: string; mangaId: string; now: number }
    | { operation: 'archive-chapter-begin'; sessionId: string; mangaId: string; chapterId: string }
    | { operation: 'archive-chapter-result'; sessionId: string; mangaId: string; chapterId: string; state: 'healthy' | 'review' | 'failed' | 'pending'; reason: string; retryable: boolean }
    | { operation: 'archive-manga-end'; sessionId: string; mangaId: string }
    | { operation: 'archive-events'; sessionId: string; after?: number }
    | { operation: 'archive-note'; sessionId: string; kind: 'catalog-retry'; reason: string };
