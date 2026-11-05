import { describe, expect, it, vi } from 'vitest';
import { ArchiveClient } from './ArchiveClient';
import { EnqueueArchiveChapter, ResumeArchiveCleanup } from './ArchiveDownload';
import { ArchivePersistenceError, type DownloadHandle, type DownloadResult } from '../DownloadContract';
import type { DownloadManager } from '../DownloadManager';
import type { Chapter } from '../providers/MangaPlugin';
import type { StorageController } from '../StorageController';
import type { ArchiveRecovery, ArchiveCommand, ArchiveReply } from '../../../../app/electron/src/archive/ArchiveProtocol';

const chapter = { Identifier: 'chapter', Parent: { Identifier: 'manga', Parent: { Identifier: 'site' } } } as Chapter;
const registration = { siteId: 'site', mangaId: 'manga', chapterId: 'chapter', title: 'Title', position: 0,
    orderConfidence: 'unknown' as const, orderEvidence: '' };
const recovery: ArchiveRecovery = { chapterKey: 'key', localState: 'not-written', sourceState: 'unknown', action: 'retry-missing', files: [], cleanup: [], stagingCleanup: [] };

function fixture(overrides: Partial<ArchiveRecovery> = {}, rejectFinish = false) {
    const receipt = { path: 'chapter.cbz', rootId: 'root', size: 4, sha256: 'a'.repeat(64), fileId: 'file' };
    const result = { outcome: 'succeeded', output: { state: 'written', files: [receipt] }, verification: { state: 'passed' },
        fetch: { receivedPages: 1 }, inputValidation: { validatedPages: 1 }, cleanup: { state: 'completed', remainingKeys: [] }, errors: [] } as unknown as DownloadResult;
    const original = { completion: Promise.resolve(result), retryCleanup: vi.fn().mockResolvedValue({ state: 'completed', remainingKeys: [], errors: [] }), cancel: vi.fn() } as unknown as DownloadHandle;
    const enqueue = vi.fn().mockResolvedValue(original);
    const invoke = vi.fn(async (command: ArchiveCommand): Promise<ArchiveReply> => {
        if (command.operation === 'session') return { ok: true, value: { root_id: 'root', settings: { format: 'application/x-cbz', useWebsiteSubDirectory: true } } };
        if (command.operation === 'register-chapter') return { ok: true, value: 'key' };
        if (command.operation === 'recover-chapter') return { ok: true, value: { ...recovery, ...overrides } };
        if (command.operation === 'begin-attempt') return { ok: true, value: 'attempt' };
        if (command.operation === 'finish-attempt' && rejectFinish) return { ok: false, error: { kind: 'repository', message: 'Transaction failed' } };
        return { ok: true, value: undefined };
    });
    return { client: new ArchiveClient(invoke), manager: { EnqueueTask: enqueue } as unknown as DownloadManager, enqueue, invoke, result };
}

describe('Durable archive download adapter', () => {
    for (const action of ['reuse', 'review', 'publish-staged'] as const) {
        it(`Should return ${action} without creating an image download`, async () => {
            const f = fixture({ action });
            expect((await EnqueueArchiveChapter(f.manager, f.client, 'session', chapter, registration)).kind).toBe(action);
            expect(f.enqueue).not.toHaveBeenCalled();
            expect(f.invoke.mock.calls.some(([command]) => command.operation === 'begin-attempt')).toBe(false);
        });
    }

    it('Should retain native receipts when the final metadata transaction fails', async () => {
        const f = fixture({}, true);
        const submitted = await EnqueueArchiveChapter(f.manager, f.client, 'session', chapter, registration);
        if (submitted.kind !== 'download') throw new Error('Expected download');
        const result = await submitted.handle.completion;
        expect(result.outcome).toBe('unverified');
        expect(result.output).toBe(f.result.output);
        expect(result.errors[0].stage).toBe('repository');
        expect(f.result.outcome).toBe('succeeded');
        expect(f.enqueue.mock.calls[0][1]).toMatchObject({ owner: 'archive:session', existingFiles: 'preserve', retention: 'release' });
    });

    it('Should reject mismatched stable identities before accessing the ledger', async () => {
        const f = fixture();
        await expect(EnqueueArchiveChapter(f.manager, f.client, 'session', chapter, { ...registration, chapterId: 'other' })).rejects.toThrow('identity');
        expect(f.invoke).not.toHaveBeenCalled();
    });

    it('Should keep persistence errors distinct from native file errors', async () => {
        const client = new ArchiveClient(async () => ({ ok: false, error: { kind: 'repository', message: 'Database full' } }));
        await expect(client.Request({ operation: 'list-sessions' })).rejects.toBeInstanceOf(ArchivePersistenceError);
    });

    it('Should resume only owned cleanup keys without fetching or clearing all temporary storage', async () => {
        const f = fixture();
        const remove = vi.fn().mockResolvedValue(undefined);
        await ResumeArchiveCleanup(f.client, { ...recovery, cleanup: [{ attemptId: 'attempt', keys: ['owned'] }, { attemptId: 'empty', keys: [] }] }, { RemoveTemporary: remove } as unknown as StorageController);
        expect(remove.mock.calls).toEqual([['owned']]);
        expect(f.invoke.mock.calls.map(([command]) => command)).toEqual([{ operation: 'record-cleanup', attemptId: 'attempt', keys: [] }]);
        expect(f.enqueue).not.toHaveBeenCalled();
    });

    it('Should abort an interrupted native write without deleting the final output', async () => {
        const cancellation = new AbortController();
        const invoke = vi.fn(async (command: ArchiveCommand): Promise<ArchiveReply> => {
            if (command.operation === 'write-chunk') cancellation.abort();
            return { ok: true, value: command.operation === 'begin-file' ? 'writer' : undefined };
        });
        const target = new ArchiveClient(invoke).Target('attempt', { root_id: 'root', settings: { format: 'image/*', useWebsiteSubDirectory: false } });
        await expect(target.write('page.png', new Blob(['data']), cancellation.signal)).rejects.toThrow();
        expect(invoke.mock.calls.map(([command]) => command.operation)).toEqual(['begin-file', 'write-chunk', 'abort-file']);
    });
});
