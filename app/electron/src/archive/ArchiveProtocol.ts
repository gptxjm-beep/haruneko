import type { ArchiveCoordinatorCommand } from './ArchiveCoordinatorProtocol';
import type { ArchiveStorageFault } from './ArchiveStorageContract';
import type { ArchiveUICommand } from './ArchiveUIContract';
import type { SelectiveQueueCommand } from './SelectiveQueueContract';
import type { MangaMetadata } from './MangaMetadata';
export const ArchiveChannel = 'ArchiveRepository::Request';
export type ArchiveReply = { ok: true; value: unknown } | { ok: false; error: { kind: 'repository' | 'filesystem' | 'validation' | 'storage'; message: string; storage?: ArchiveStorageFault } };

export interface ArchiveIdentity {
    siteId: string;
    mangaId: string;
    chapterId: string;
}

export interface ChapterRegistration extends ArchiveIdentity {
    title: string;
    position: number;
    orderConfidence: 'unknown' | 'connector-contract' | 'verified-ascending' | 'user-confirmed';
    orderEvidence: string;
    expectedPages?: number;
    expectedPagesTrusted?: boolean;
    expectedPagesEvidence?: string;
}

export interface ArchiveFileReceipt {
    fileId: string;
    rootId: string;
    path: string;
    size: number;
    sha256: string;
    reused?: boolean;
}

export interface ArchiveAttemptResult {
    timings?: Readonly<Record<string, number>>;
    outcome: string;
    receivedPages: number;
    validatedPages: number;
    outputState: string;
    verification: string;
    cleanupState: string;
    cleanupKeys: string[];
    errors: { stage: string; message: string }[];
}

export type ArchiveCommand = ArchiveCoordinatorCommand | ArchiveUICommand | SelectiveQueueCommand
    | { operation: 'catalog-log'; runId: string; event: Record<string, unknown> }
    | { operation: 'catalog-open-logs' }
    | { operation: 'queue-details-inspect'; seq: number }
    | { operation: 'queue-audit'; seq: number }
    | { operation: 'queue-export-report'; seq: number }
    | { operation: 'queue-cover'; seq: number }
    | { operation: 'queue-details-save'; seq: number; text?: string; cover?: Uint8Array; extension?: string; partial: boolean; metadata?: MangaMetadata }
    | { operation: 'storage-check'; sessionId: string }
    | { operation: 'storage-image'; attemptId: string; bytes: number; quota: { usage: number; quota: number } }
    | { operation: 'storage-image-preflight'; attemptId: string; quota: { usage: number; quota: number } }
    | { operation: 'storage-prepare'; attemptId: string; bytes: number }
    | { operation: 'storage-release'; attemptId: string }
    | { operation: 'choose-root' }
    | { operation: 'create-session'; rootId: string; siteId: string; siteName: string; settings: { format: string; useWebsiteSubDirectory: boolean } }
    | { operation: 'list-sessions' }
    | { operation: 'session'; sessionId: string }
    | { operation: 'register-chapter'; sessionId: string; chapter: ChapterRegistration }
    | { operation: 'begin-attempt'; sessionId: string; chapterKey: string }
    | { operation: 'checkpoint'; attemptId: string; stage: string; receivedPages?: number; validatedPages?: number; expectedFiles?: number }
    | { operation: 'begin-file'; attemptId: string; path: string; size: number }
    | { operation: 'write-chunk'; writeId: string; bytes: Uint8Array }
    | { operation: 'finish-file'; writeId: string }
    | { operation: 'abort-file'; writeId: string }
    | { operation: 'finish-attempt'; attemptId: string; result: ArchiveAttemptResult }
    | { operation: 'recover-chapter'; sessionId: string; chapterKey: string; fullAudit?: boolean }
    | { operation: 'publish-staged'; fileId: string }
    | { operation: 'inspect-path'; sessionId: string; path: string; hash?: boolean }
    | { operation: 'list-chapters'; sessionId: string; after?: string }
    | { operation: 'set-session-state'; sessionId: string; state: 'paused' | 'active' | 'closed' }
    | { operation: 'record-cleanup'; attemptId: string; keys: string[]; error?: string };

export interface ArchiveRecovery {
    chapterKey: string;
    localState: 'healthy' | 'missing' | 'damaged' | 'partial' | 'uncertain' | 'not-written';
    sourceState: 'unknown' | 'complete' | 'incomplete';
    action: 'reuse' | 'retry-missing' | 'review' | 'publish-staged';
    files: { fileId: string; path: string; state: string; checkedBy: string }[];
    cleanup: { attemptId: string; keys: string[] }[];
    stagingCleanup: string[];
}
