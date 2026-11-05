import type { Chapter } from '../providers/MangaPlugin';
import type { DownloadManager } from '../DownloadManager';
import type { DownloadHandle, DownloadResult } from '../DownloadContract';
import type { StorageController } from '../StorageController';
import type { ArchiveRecovery, ChapterRegistration } from '../../../../app/electron/src/archive/ArchiveProtocol';
import type { ArchiveClient } from './ArchiveClient';

export type ArchiveChapterSubmission =
    | { kind: 'reuse' | 'review' | 'publish-staged'; chapterKey: string; recovery: ArchiveRecovery }
    | { kind: 'download'; chapterKey: string; attemptId: string; handle: DownloadHandle };

/** A single-chapter adapter, not a site scheduler. Never guesses that uncertain files are replaceable. */
export async function EnqueueArchiveChapter(manager: DownloadManager, client: ArchiveClient, sessionId: string, chapter: Chapter,
    registration: ChapterRegistration, options: { signal?: AbortSignal; reviewedRetry?: boolean; pageDelayMs?: number; beforeTemporaryWrite?: (bytes: number) => Promise<void> } = {}): Promise<ArchiveChapterSubmission> {
    if (registration.siteId !== chapter.Parent?.Parent?.Identifier || registration.mangaId !== chapter.Parent?.Identifier || registration.chapterId !== chapter.Identifier) throw new Error('Archive identity does not match the selected chapter');
    const session = await client.Request<{ root_id: string; settings: { format: string; useWebsiteSubDirectory: boolean } }>({ operation: 'session', sessionId });
    const chapterKey = await client.Request<string>({ operation: 'register-chapter', sessionId, chapter: registration });
    const recovery = await client.Request<ArchiveRecovery>({ operation: 'recover-chapter', sessionId, chapterKey });
    if (!options.reviewedRetry && recovery.action !== 'retry-missing') return { kind: recovery.action, chapterKey, recovery };
    const attemptId = await client.Request<string>({ operation: 'begin-attempt', sessionId, chapterKey });
    const target = client.Target(attemptId, session);
    let original: DownloadHandle;
    try {
        original = await manager.EnqueueTask(chapter, { archiveTarget: target, format: target.format, useWebsiteSubDirectory: target.useWebsiteSubDirectory,
            owner: `archive:${sessionId}`, signal: options.signal, retention: 'release', existingFiles: 'preserve', pageDelayMs: options.pageDelayMs,
            beforeTemporaryWrite: options.beforeTemporaryWrite });
    } catch(error) {
        await client.Request({ operation: 'finish-attempt', attemptId, result: { outcome: 'failed', receivedPages: 0, validatedPages: 0,
            outputState: 'not-started', verification: 'not-performed', cleanupState: 'not-needed', cleanupKeys: [], errors: [{ stage: 'repository', message: String(error) }] } });
        throw error;
    }
    const completion = original.completion.then(async result => {
        try {
            await client.Request({ operation: 'finish-attempt', attemptId, result: {
                outcome: result.outcome, receivedPages: result.fetch.receivedPages, validatedPages: result.inputValidation.validatedPages,
                outputState: result.output.state, verification: result.verification.state, cleanupState: result.cleanup.state,
                cleanupKeys: [...result.cleanup.remainingKeys], errors: result.errors.map(error => ({ stage: error.stage, message: error.error.message || 'Unknown error' })),
            } });
            await client.Request({ operation: 'recover-chapter', sessionId, chapterKey });
            return result;
        } catch(error) {
            // A failed metadata transaction does not erase the already-written file receipt.
            return Object.freeze({ ...result, outcome: 'unverified', errors: Object.freeze([...result.errors,
                Object.freeze({ stage: 'repository' as const, error: error instanceof Error ? error : new Error(String(error)) })]) }) as DownloadResult;
        }
    });
    const handle: DownloadHandle = Object.freeze({ ...original, completion,
        retryCleanup: async () => {
            const cleaned = await original.retryCleanup();
            await client.Request({ operation: 'record-cleanup', attemptId, keys: [...cleaned.remainingKeys], error: cleaned.errors[0]?.message });
            return cleaned;
        },
    });
    return { kind: 'download', chapterKey, attemptId, handle };
}

export async function ResumeArchiveCleanup(client: ArchiveClient, recovery: ArchiveRecovery, storage: StorageController): Promise<void> {
    for (const pending of recovery.cleanup) {
        if (!pending.keys.length) continue;
        try {
            await storage.RemoveTemporary(...pending.keys);
            await client.Request({ operation: 'record-cleanup', attemptId: pending.attemptId, keys: [] });
        } catch(error) {
            await client.Request({ operation: 'record-cleanup', attemptId: pending.attemptId, keys: pending.keys, error: String(error) });
            throw error;
        }
    }
    for (const fileId of recovery.stagingCleanup) await client.Request({ operation: 'publish-staged', fileId });
}
