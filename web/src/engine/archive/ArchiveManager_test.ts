import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as ArchiveSchema from '../../../../app/electron/src/archive/ArchiveSchema';
import { ArchiveRepository } from '../../../../app/electron/src/archive/ArchiveRepository';
import { ArchiveFiles } from '../../../../app/electron/src/archive/ArchiveFiles';
import type { ArchiveCoordinatorCommand, ArchivePolicy } from '../../../../app/electron/src/archive/ArchiveCoordinatorProtocol';
import type { ArchiveCommand, ArchiveReply } from '../../../../app/electron/src/archive/ArchiveProtocol';
import { ArchiveClient } from './ArchiveClient';
import { ArchiveManager } from './ArchiveManager';
import { EngineArchiveSource, type ArchiveSource, type ArchiveChapterManifest } from './ArchiveSource';
import type { EnqueueArchiveChapter } from './ArchiveDownload';
import { Manga, Chapter, type MangaPlugin, type MangaScraper } from '../providers/MangaPlugin';
import { DownloadManager } from '../DownloadManager';
import { ArchiveCapacityError, type DownloadResult, type DownloadHandle } from '../DownloadContract';
import type { ArchiveStorageFault } from '../../../../app/electron/src/archive/ArchiveStorageContract';
import type { StorageController } from '../StorageController';
import { Tags } from '../Tags';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const complete = { state: 'complete' as const, evidence: 'Isolated fixture manifest, all pages visited' };

async function fixture(catalog = [{ id: 'manga', title: 'Manga' }], schemaVersion?: number) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-manager-'));
    const root = path.join(base, 'output');
    await fs.mkdir(root);
    const filename = path.join(base, 'profile', 'state.sqlite');
    // Reproduce the old application's schema through the real constructor, without editing persisted evidence or PRAGMA.
    const migrate = ArchiveSchema.MigrateArchiveDatabase;
    const migration = schemaVersion === undefined ? undefined : vi.spyOn(ArchiveSchema, 'MigrateArchiveDatabase').mockImplementationOnce(database => migrate(database, schemaVersion));
    let repository: ArchiveRepository;
    try { repository = new ArchiveRepository(filename); } finally { migration?.mockRestore(); }
    let files = new ArchiveFiles(repository);
    const grant = repository.GrantRoot(root);
    const session = repository.CreateSession(grant.rootId, 'site', 'Site', { format: 'application/x-cbz', useWebsiteSubDirectory: false });
    cleanups.push(async () => { await files.Close(); repository.Close(); await fs.rm(base, { recursive: true, force: true }); });
    const manifests = new Map<string, ArchiveChapterManifest>();
    for (const manga of catalog) manifests.set(manga.id, { chapters: [{ id: 'new', title: 'Special', position: 0, language: 'ar' }, { id: 'old', title: '1.5', position: 1, language: 'ar' }], order: 'descending', orderEvidence: 'Fixture newest-first', coverage: complete });
    const scraper = { FetchChapters: vi.fn(async (manga: Manga) => manifests.get(manga.Identifier)!.chapters.map(item => new Chapter(scraper as unknown as MangaScraper, manga, item.id, item.title))) };
    const site = { Identifier: 'site', Title: 'Site', URI: new URL('https://fixture.invalid'), Tags: { Value: [Tags.Language.Multilingual] }, Entries: { Value: [] }, Update: vi.fn(), Initialize: vi.fn().mockResolvedValue(undefined),
        CreateEntry: (id: string, title: string) => new Manga(scraper as unknown as MangaScraper, site, id, title) } as unknown as MangaPlugin;
    let intercept: ((command: ArchiveCommand) => void) | undefined;
    let storageFault: ArchiveStorageFault | undefined;
    const invoke = vi.fn(async (command: ArchiveCommand): Promise<ArchiveReply> => {
        try {
            intercept?.(command);
            let value: unknown;
            if (command.operation.startsWith('archive-')) value = repository.Work.Execute(command as ArchiveCoordinatorCommand);
            else switch (command.operation) {
                case 'session': value = repository.Session(command.sessionId); break;
                case 'storage-check':
                    if (storageFault) return { ok: false, error: { kind: 'storage', message: `Storage ${storageFault.code}`, storage: storageFault } };
                    value = undefined; break;
                case 'recover-chapter': value = await files.Recover(command.sessionId, command.chapterKey); break;
                default: throw new Error('Unexpected test command ' + command.operation);
            }
            return { ok: true, value };
        } catch(error) { return { ok: false, error: { kind: 'repository', message: String(error) } }; }
    });
    const client = new ArchiveClient(invoke);
    const source: ArchiveSource = { site,
        Catalog: async function* () { for (let offset = 0; offset < catalog.length; offset += 100) yield { items: catalog.slice(offset, offset + 100), terminal: offset + 100 >= catalog.length, coverage: complete }; },
        Chapters: vi.fn(async manga => manifests.get(manga.Identifier)!),
    };
    const downloads = new DownloadManager({ SaveTemporary: async () => 'manual-temp', RemoveTemporary: async () => {} } as unknown as StorageController);
    const calls: string[] = [];
    const faults = new Set<string>();
    let beforeDownload: ((id: string, signal: AbortSignal) => Promise<void>) | undefined;
    const enqueue: typeof EnqueueArchiveChapter = async (_manager, _client, _session, chapter, registration, options) => {
        const id = `${registration.mangaId}/${registration.chapterId}`;
        calls.push(id);
        const key = repository.RegisterChapter(session, registration);
        const attemptId = repository.BeginAttempt(session, key);
        const completion = (async () => {
            await beforeDownload?.(id, options!.signal!);
            const cancelled = options?.signal?.aborted;
            const failed = faults.has(id);
            const result = { outcome: cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded',
                fetch: { receivedPages: failed || cancelled ? 0 : 1 }, cleanup: { state: 'completed', remainingKeys: [] },
                errors: failed ? [{ stage: 'fetch', error: new Error('Network offline') }] : [] } as unknown as DownloadResult;
            if (!failed && !cancelled) {
                repository.Checkpoint(attemptId, 'export', 1, 1, 1);
                const token = await files.Begin(attemptId, `${id}.cbz`, 4);
                await files.Chunk(token, new Uint8Array([1, 2, 3, 4]));
                await files.Finish(token);
            }
            repository.FinishAttempt(attemptId, { outcome: result.outcome, receivedPages: failed || cancelled ? 0 : 1, validatedPages: failed || cancelled ? 0 : 1,
                outputState: failed || cancelled ? 'not-started' : 'written', verification: failed || cancelled ? 'not-performed' : 'passed', cleanupState: 'completed', cleanupKeys: [], errors: result.errors.map(item => ({ stage: item.stage, message: item.error.message })) });
            return result;
        })();
        return { kind: 'download', chapterKey: key, attemptId, handle: { completion, cancel: vi.fn() } as unknown as DownloadHandle };
    };
    const policy: ArchivePolicy = { maxMangas: 5, maxChapters: 20, delayMs: 100, retryDelayMs: 1000, maxAttempts: 2, languages: [], unknownLanguage: 'include' };
    return { site, source, policy, client, downloads, calls, manifests, faults, root, session, invoke,
        get Repository() { return repository; },
        manager: () => new ArchiveManager(site, downloads, client, session, policy, { source, enqueue }),
        setIntercept: (value: typeof intercept) => { intercept = value; },
        setStorageFault: (value: typeof storageFault) => { storageFault = value; },
        setBeforeDownload: (value: typeof beforeDownload) => { beforeDownload = value; },
        async reopen() { await files.Close(); repository.Close(); repository = new ArchiveRepository(filename); files = new ArchiveFiles(repository); },
    };
}

describe('Smart ArchiveManager with a real isolated SQLite ledger', () => {
    it('Should discover native archive entries without writing the manual UI cache', async () => {
        const f = await fixture();
        f.site.FetchArchiveEntries = vi.fn().mockResolvedValue([f.site.CreateEntry('manga', 'Manga')]);
        const source = new EngineArchiveSource(f.site);
        const pages = [];
        for await (const page of source.Catalog(new AbortController().signal)) pages.push(page);
        expect(pages[0].items).toEqual([{ id: 'manga', title: 'Manga' }]);
        expect(f.site.Update).not.toHaveBeenCalled();
        expect(f.site.Entries.Value).toEqual([]);
    });
    it('Should pause before discovery when storage is low and resume after capacity is restored', async () => {
        const f = await fixture();
        f.setStorageFault({ code: 'low-space', location: 'archive' });
        const stopped = await f.manager().Start();
        expect(stopped.state).toBe('paused');
        expect(stopped.storageError?.code).toBe('low-space');
        expect(stopped.catalogAttempts).toBe(0);
        expect(f.calls).toEqual([]);
        await f.reopen();
        expect(f.Repository.Work.Snapshot(f.session).storageError?.code).toBe('low-space');
        f.setStorageFault(undefined);
        const resumed = await f.manager().Resume();
        expect(resumed.state).toBe('drained');
        expect(resumed.storageError).toBeNull();
    });

    it('Should not spend the connector retry allowance on a storage stop during a chapter', async () => {
        const f = await fixture();
        f.policy.maxAttempts = 1;
        f.setBeforeDownload(async () => { throw new ArchiveCapacityError('Quota exhausted', { code: 'quota-exceeded', location: 'indexeddb' }); });
        const stopped = await f.manager().Start();
        expect(stopped.state).toBe('paused');
        expect(stopped.storageError?.code).toBe('quota-exceeded');
        expect(stopped.chaptersStarted).toBe(1);
        f.setBeforeDownload(undefined);
        expect((await f.manager().Resume()).state).toBe('drained');
        expect(f.calls).toEqual(['manga/old', 'manga/old', 'manga/new']);
    });

    it('Should retain the storage fault when the caller also requested a graceful pause', async () => {
        const f = await fixture();
        const manager = f.manager();
        f.setBeforeDownload(async () => {
            void manager.Pause();
            throw new ArchiveCapacityError('Disk became full', { code: 'write-full', location: 'archive' });
        });
        const stopped = await manager.Start();
        expect(stopped.state).toBe('paused');
        expect(stopped.storageError?.code).toBe('write-full');
        f.setBeforeDownload(undefined);
        expect((await f.manager().Resume()).state).toBe('drained');
    });

    it('Should preserve the capacity fault if SQLite cannot save the pause receipt', async () => {
        const f = await fixture();
        f.setStorageFault({ code: 'write-full', location: 'database' });
        f.setIntercept(command => { if (command.operation === 'archive-storage-stop') throw new Error('SQLITE_FULL'); });
        const error = await f.manager().Start().catch(error => error);
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.cause.Fault.code).toBe('write-full');
        expect(f.calls).toEqual([]);
    });

    it('Should reuse healthy outputs after a disconnected destination is restored', async () => {
        const f = await fixture();
        await f.manager().Start();
        f.setStorageFault({ code: 'disconnected', location: 'archive' });
        expect((await f.manager().Resume()).storageError?.code).toBe('disconnected');
        f.setStorageFault(undefined);
        expect((await f.manager().Resume()).counts.healthy).toBe(2);
        expect(f.calls.length).toBe(2);
    });
    it('Should register 364 chapters in bounded batches and download only the oldest twenty', async () => {
        const f = await fixture();
        f.manifests.get('manga')!.chapters = Array.from({ length: 364 }, (_, index) => ({ id: `c${363 - index}`, title: `Chapter ${363 - index}`, position: index, language: 'ar' }));
        const result = await f.manager().Start();
        expect(result.state).toBe('limited');
        expect(result.counts.healthy).toBe(20);
        expect(result.counts.pending).toBe(344);
        expect(f.calls).toEqual(Array.from({ length: 20 }, (_, index) => `manga/c${index}`));
    }, 15_000);

    it('Should resume a 364-chapter registration interrupted between batches without publishing a partial list', async () => {
        const f = await fixture();
        const chapters = Array.from({ length: 364 }, (_, position) => ({ id: `c${position}`, title: `C${position}`, position, language: 'ar' }));
        const command = (input: Record<string, unknown>) => f.Repository.Work.Execute({ sessionId: f.session, ...input } as ArchiveCoordinatorCommand);
        command({ operation: 'archive-run-open', policy: f.policy });
        command({ operation: 'archive-catalog-page', items: [{ id: 'manga', title: 'Manga' }] });
        command({ operation: 'archive-catalog-end', index: complete });
        command({ operation: 'archive-manga-begin', mangaId: 'manga' });
        const token = command({ operation: 'archive-manifest-begin', mangaId: 'manga', count: 364, order: 'ascending', orderEvidence: 'Fixture', evidence: complete });
        command({ operation: 'archive-manifest-batch', mangaId: 'manga', manifestId: token, offset: 0, chapters: chapters.slice(0, 200) });
        expect(command({ operation: 'archive-next-chapter', mangaId: 'manga', now: Date.now() })).toBeNull();
        expect(f.Repository.Work.Snapshot(f.session).counts.pending).toBeUndefined();
        await f.reopen();
        f.manifests.get('manga')!.chapters = chapters;
        f.manifests.get('manga')!.order = 'ascending';
        const result = await f.manager().Resume();
        expect(result.state).toBe('limited');
        expect(result.counts.healthy).toBe(20);
        expect(result.counts.pending).toBe(344);
        expect(f.calls).toEqual(Array.from({ length: 20 }, (_, index) => `manga/c${index}`));
    }, 15_000);

    it('Should pause catalog discovery repeatedly without spending connector failure attempts', async () => {
        const f = await fixture();
        const manager = f.manager();
        let interruptions = 0;
        f.source.Catalog = async function* () {
            if (interruptions++ < 4) void manager.Pause();
            yield { items: [{ id: 'manga', title: 'Manga' }], terminal: true, coverage: complete };
        };
        for (let index = 0; index < 4; index++) {
            const result = await manager.Start();
            expect(result.state).toBe('paused');
            expect(result.catalogDone).toBe(false);
            expect(result.catalogAttempts).toBe(0);
            expect(result.catalogState).toBe('paused');
            expect(result.index.state).toBe('partial');
            await f.reopen();
        }
        expect((await manager.Resume()).state).toBe('drained');
        expect(f.calls).toEqual(['manga/old', 'manga/new']);
    });

    it('Should retain genuine catalog failures even when the caller also pauses', async () => {
        const f = await fixture();
        const manager = f.manager();
        f.source.Catalog = async function* () { void manager.Pause(); throw new Error('Real connector network failure'); };
        for (let attempt = 1; attempt <= 2; attempt++) {
            const snapshot = await manager.Start();
            expect(snapshot.state).toBe('paused');
            expect(snapshot.catalogAttempts).toBe(attempt);
            expect(snapshot.catalogState).toBe('failed');
        }
        expect((await manager.Resume()).state).toBe('review');
        expect(f.calls).toEqual([]);
    });

    it('Should not prove index completeness merely because the generator ended', async () => {
        const f = await fixture();
        f.source.Catalog = async function* () { yield { items: [{ id: 'manga', title: 'Manga' }], terminal: false, coverage: complete }; };
        const result = await f.manager().Start();
        expect(result.index.state).toBe('unknown');
        expect(result.state).toBe('review');
    });
    it('Should process multiple mangas oldest-first without consulting read state', async () => {
        const f = await fixture([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
        const result = await f.manager().Start();
        expect(f.calls).toEqual(['a/old', 'a/new', 'b/old', 'b/new']);
        expect(result.counts.healthy).toBe(4);
        expect(result.state).toBe('drained');
        expect(f.Repository.Session(f.session).state).not.toBe('completed');
    });

    it('Should preserve a saved manifest across close/reopen and changed source order, and reuse healthy files', async () => {
        const f = await fixture();
        const first = f.manager();
        f.setBeforeDownload(async () => { void first.Pause(); });
        expect((await first.Start()).state).toBe('paused');
        expect(f.calls).toEqual(['manga/old']);
        await f.reopen();
        f.manifests.get('manga')!.chapters = [...f.manifests.get('manga')!.chapters].reverse();
        f.setBeforeDownload(undefined);
        expect((await f.manager().Resume()).state).toBe('drained');
        expect(f.calls).toEqual(['manga/old', 'manga/new']);
        expect((await f.manager().Resume()).counts.healthy).toBe(2);
        expect(f.calls.length).toBe(2);
    });

    it.each([6, 7])('Should quarantine real Manager evidence from v%s without changing saved files, identities, receipts or budgets', async version => {
        const f = await fixture(undefined, 6);
        f.manifests.get('manga')!.orderEvidence = 'MangaScraper.FetchChapters guarantees newest-first after connector decorators';
        const manager = f.manager();
        f.setBeforeDownload(async () => { void manager.Pause(); });
        await manager.Start();
        const database = f.Repository['database'];
        const evidence = 'Original descending; normalized oldest-first once. MangaScraper.FetchChapters guarantees newest-first after connector decorators';
        expect(database.prepare('SELECT order_evidence FROM session_chapters ORDER BY position').all()).toEqual([
            { order_evidence: 'Saved oldest-first connector manifest; no title-number inference' }, { order_evidence: evidence },
        ]);
        expect(database.prepare('SELECT order_evidence FROM archive_manifests').get()!.order_evidence).toBe(evidence);
        if (version === 7) ArchiveSchema.MigrateArchiveDatabase(database, 7);
        expect(database.prepare('PRAGMA user_version').get()!.user_version).toBe(version);
        expect(database.prepare("SELECT count(*) AS n FROM archive_work WHERE state='pending'").get()!.n).toBe(1);
        const preserved = ['files', 'attempt_files', 'attempts', 'chapters', 'errors', 'conflicts'].map(table => ({ table, rows: database.prepare(`SELECT * FROM ${table}`).all() }));
        const chapters = database.prepare('SELECT * FROM session_chapters').all();
        const work = database.prepare('SELECT id,chapter_key,position,attempts FROM archive_work ORDER BY id').all();
        const budgets = database.prepare('SELECT mangas_used,chapters_started,catalog_attempts FROM archive_runs').get();
        expect(preserved[0].rows).toHaveLength(1);
        const bytes = await fs.readFile(path.join(f.root, 'manga', 'old.cbz'));
        // Inspect the migration before startup recovery legitimately changes Verifying to Interrupted.
        ArchiveSchema.MigrateArchiveDatabase(database);
        const upgraded = database;
        expect(upgraded.prepare('PRAGMA user_version').get()!.user_version).toBe(11);
        expect(upgraded.prepare('SELECT DISTINCT state FROM archive_work').all()).toEqual([{ state: 'review' }]);
        expect(upgraded.prepare('SELECT ordering,order_evidence FROM archive_manifests').get()).toMatchObject({ ordering: 'unknown', order_evidence: evidence });
        expect(upgraded.prepare('SELECT * FROM session_chapters').all()).toEqual(chapters.map(row => ({ ...row, order_confidence: 'unknown' })));
        for (const { table, rows } of preserved) expect(upgraded.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
        expect(upgraded.prepare('SELECT id,chapter_key,position,attempts FROM archive_work ORDER BY id').all()).toEqual(work);
        expect(upgraded.prepare('SELECT mangas_used,chapters_started,catalog_attempts FROM archive_runs').get()).toEqual(budgets);
        await f.reopen();
        f.setBeforeDownload(undefined);
        const resumed = await f.manager().Resume();
        expect(resumed.state).toBe('review');
        expect(resumed.counts.review).toBe(2);
        expect(resumed.chaptersStarted).toBe(1);
        expect(f.calls).toEqual(['manga/old']);
        expect(await fs.readFile(path.join(f.root, 'manga', 'old.cbz'))).toEqual(bytes);
        expect(f.Repository['database'].prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    });

    it('Should preserve an independent chapter proof even alongside a historical manifest when upgrading v7', async () => {
        const f = await fixture(undefined, 7);
        f.manifests.get('manga')!.orderEvidence = 'MangaScraper.FetchChapters guarantees newest-first after connector decorators';
        const manager = f.manager();
        f.setBeforeDownload(async () => { void manager.Pause(); });
        await manager.Start();
        f.Repository.RegisterChapter(f.session, { siteId: 'site', mangaId: 'manga', chapterId: 'new', title: 'Special', position: 1,
            orderConfidence: 'verified-ascending', orderEvidence: 'Independent structured API position audit' });
        await f.reopen();
        expect(f.Repository['database'].prepare("SELECT order_confidence,order_evidence FROM session_chapters sc JOIN chapters c ON c.key=sc.chapter_key WHERE c.chapter_id='new'").get())
            .toMatchObject({ order_confidence: 'verified-ascending', order_evidence: 'Independent structured API position audit' });
        expect(f.Repository['database'].prepare("SELECT state FROM archive_work WHERE id='new'").get()!.state).toBe('pending');
        expect(f.Repository['database'].prepare("SELECT state FROM archive_work WHERE id='old'").get()!.state).toBe('review');
    });

    it('Should continue after one inaccessible chapter, with bounded delayed retries', async () => {
        const f = await fixture();
        f.faults.add('manga/old');
        const result = await f.manager().Start();
        expect(f.calls).toEqual(['manga/old', 'manga/new', 'manga/old']);
        expect(result.counts.failed).toBe(1);
        expect(result.counts.healthy).toBe(1);
        expect(result.state).toBe('review');
    });

    it('Should retain partial catalog and chapter-list uncertainty', async () => {
        const f = await fixture();
        f.source.Catalog = async function* () { yield { items: [{ id: 'manga', title: 'Manga' }], terminal: true, coverage: { state: 'partial', evidence: 'Only first page available' } }; };
        f.manifests.get('manga')!.coverage = { state: 'unknown', evidence: 'Unverified pagination' };
        const result = await f.manager().Start();
        expect(result.index.state).toBe('partial');
        expect(result.counts.healthy).toBe(2);
        expect(result.state).toBe('review');
    });

    it('Should revisit temporarily empty mangas after a delay, without an endless loop', async () => {
        const f = await fixture();
        const manifest = f.manifests.get('manga')!;
        let count = 0;
        f.source.Chapters = vi.fn(async () => ++count === 1 ? { ...manifest, chapters: [] } : manifest);
        expect((await f.manager().Start()).state).toBe('drained');
        expect(count).toBe(2);
        const empty = await fixture();
        empty.source.Chapters = vi.fn(async () => ({ ...manifest, chapters: [] }));
        expect((await empty.manager().Start()).state).toBe('review');
        expect(empty.source.Chapters).toHaveBeenCalledTimes(2);
    });

    it('Should deduplicate identities across catalog and chapter pages without merging duplicate titles', async () => {
        const f = await fixture([{ id: 'manga', title: 'Manga' }, { id: 'manga', title: 'Manga' }]);
        const manifest = f.manifests.get('manga')!;
        manifest.chapters = [manifest.chapters[0], manifest.chapters[0], { ...manifest.chapters[1], title: 'Special' }];
        expect((await f.manager().Start()).counts.healthy).toBe(2);
        expect(f.calls).toEqual(['manga/old', 'manga/new']);
        const events = f.Repository.Work.Execute({ operation: 'archive-events', sessionId: f.session }) as { kind: string }[];
        expect(events.some(event => event.kind === 'duplicate-manga')).toBe(true);
        expect(events.some(event => event.kind === 'duplicate-chapter')).toBe(true);
    });

    it('Should record language exclusions and unknown languages explicitly', async () => {
        const f = await fixture();
        f.policy.languages = ['ar']; f.policy.unknownLanguage = 'review';
        f.manifests.get('manga')!.chapters = [
            { id: 'ar', title: 'Arabic', position: 0, language: 'ar' },
            { id: 'en', title: 'English', position: 1, language: 'en' },
            { id: 'unknown', title: 'Unknown', position: 2, language: null },
        ];
        const result = await f.manager().Start();
        expect(f.calls).toEqual(['manga/ar']);
        expect(result.counts.excluded).toBe(1);
        expect(result.counts.review).toBe(1);
        expect(result.state).toBe('review');
    });

    it('Should review conflicting language variants sharing one chapter ID', async () => {
        const f = await fixture();
        f.manifests.get('manga')!.chapters = [{ id: 'same', title: 'Chapter', position: 0, language: 'ar' }, { id: 'same', title: 'Chapter', position: 1, language: 'en' }];
        expect((await f.manager().Start()).counts.review).toBe(1);
        expect(f.calls).toEqual([]);
    });

    it('Should cancel only its owned attempt and never start the next chapter', async () => {
        const f = await fixture();
        const manager = f.manager();
        f.setBeforeDownload(async () => { void manager.Cancel(); });
        expect((await manager.Start()).state).toBe('cancelled');
        expect(f.calls).toEqual(['manga/old']);
        await expect(f.manager().Resume()).rejects.toThrow('cancelled');
    });

    it('Should leave an independent manual download running when an archive is cancelled', async () => {
        const f = await fixture();
        let release!: (data: Blob) => void;
        const data = new Blob(['manual']);
        const media = { Identifier: 'manual', Entries: { Value: [{ Fetch: () => new Promise<Blob>(resolve => { release = resolve; }) }] },
            Update: async () => {}, IsSameAs: () => false, Store: async (_resources, options) => {
                await options.context.begin(1);
                options.context.written({ path: 'manual.cbz', size: data.size, handle: { getFile: async () => data } });
            } };
        const manual = await f.downloads.EnqueueTask(media as unknown as Chapter);
        const manager = f.manager();
        f.setBeforeDownload(async () => { void manager.Cancel(); });
        expect((await manager.Start()).state).toBe('cancelled');
        release(data);
        expect((await manual.completion).outcome).toBe('succeeded');
        expect(f.downloads.Queue.Value.length).toBe(1);
    });

    it('Should require review for corrupt files instead of downloading over them', async () => {
        const f = await fixture();
        await f.manager().Start();
        await fs.writeFile(path.join(f.root, 'manga/old.cbz'), 'evil');
        const state = await f.manager().Resume();
        expect(state.counts.review).toBe(1);
        expect(f.calls).toEqual(['manga/old', 'manga/new']);
        expect(await fs.readFile(path.join(f.root, 'manga/old.cbz'), 'utf8')).toBe('evil');
    });

    it('Should review repeatedly missing files when the retry budget is exhausted', async () => {
        const f = await fixture();
        await f.manager().Start();
        await fs.unlink(path.join(f.root, 'manga/old.cbz'));
        await f.manager().Resume();
        await fs.unlink(path.join(f.root, 'manga/old.cbz'));
        expect((await f.manager().Resume()).state).toBe('review');
        expect(f.calls.filter(id => id === 'manga/old').length).toBe(2);
    });

    it('Should stop on SQLite checkpoint failure, then reconcile written bytes without another download', async () => {
        const f = await fixture();
        f.setIntercept(command => { if (command.operation === 'archive-chapter-result') throw new Error('Injected SQLite transaction failure'); });
        await expect(f.manager().Start()).rejects.toThrow('SQLite');
        expect(f.calls).toEqual(['manga/old']);
        f.setIntercept(undefined);
        await f.reopen();
        expect((await f.manager().Resume()).state).toBe('drained');
        expect(f.calls).toEqual(['manga/old', 'manga/new']);
    });

    it('Should enforce cumulative limits across repeated resumes', async () => {
        const f = await fixture();
        f.policy.maxChapters = 1;
        expect((await f.manager().Start()).state).toBe('limited');
        expect((await f.manager().Resume()).state).toBe('limited');
        expect(f.calls).toEqual(['manga/old']);
    });

    it('Should pause at a manga boundary without starting any chapter', async () => {
        const f = await fixture();
        const manager = new ArchiveManager(f.site, f.downloads, f.client, f.session, f.policy, { source: f.source,
            beforeCapacity: async checkpoint => { if (checkpoint.phase === 'before-manga') void manager.Pause(); } });
        expect((await manager.Start()).state).toBe('paused');
        expect(f.calls).toEqual([]);
        expect((await f.manager().Resume()).counts.healthy).toBe(2);
    });

    it('Should persist a returned chapter manifest during graceful pause without spending another listing attempt', async () => {
        const f = await fixture();
        f.policy.maxAttempts = 1;
        const manager = f.manager();
        f.source.Chapters = vi.fn(async () => { void manager.Pause(); return f.manifests.get('manga')!; });
        expect((await manager.Start()).state).toBe('paused');
        expect(f.calls).toEqual([]);
        expect((await f.manager().Resume()).counts.healthy).toBe(2);
        expect(f.source.Chapters).toHaveBeenCalledTimes(1);
    });

    it('Should recheck an empty index a bounded number of times without claiming completeness', async () => {
        const f = await fixture();
        let calls = 0;
        f.source.Catalog = async function* () { calls++; yield { items: [], terminal: true, coverage: complete }; };
        const state = await f.manager().Start();
        expect(state.index.state).toBe('unknown');
        expect(state.state).toBe('review');
        expect(calls).toBe(2);
    });

    it('Should persist a large streamed catalog without retaining work arrays in the manager', async () => {
        const f = await fixture(Array.from({ length: 1000 }, (_, index) => ({ id: `m${index}`, title: `M${index}` })));
        f.policy.maxMangas = 1;
        const manager = f.manager();
        expect((await manager.Start()).state).toBe('limited');
        expect(f.calls.length).toBe(2);
        expect(f.Repository.Work.Snapshot(f.session).counts['manga:pending']).toBe(999);
        expect(Object.values(manager.State.Value!).some(Array.isArray)).toBe(false);
        expect(f.downloads.Queue.Value.length).toBe(0);
    });

    it('Should require review when trusted expected pages differ from received pages', async () => {
        const f = await fixture();
        f.manifests.get('manga')!.chapters = [{ id: 'mismatch', title: 'Chapter', position: 0, language: null, expectedPages: 2, expectedPagesTrusted: true, expectedPagesEvidence: 'Fixture page manifest' }];
        const result = await f.manager().Start();
        expect(result.counts.review).toBe(1);
        expect(result.counts.healthy).toBeUndefined();
        expect(f.calls.length).toBe(1);
    });

    it('Should never guess unknown order from decimal or special chapter titles', async () => {
        const f = await fixture(); f.manifests.get('manga')!.order = 'unknown';
        expect((await f.manager().Start()).counts.review).toBe(2);
        expect(f.calls).toEqual([]);
    });

    it.each(['ascending', 'descending'] as const)('Should execute the engine adapter oldest-first with verified %s input', async order => {
        const f = await fixture();
        const oldestFirst = [{ id: 'old', title: 'Chapter 0', position: 0, language: 'ar' },
            { id: 'fraction', title: '0.5', position: 1, language: 'ar' },
            { id: 'special-a', title: 'Special', position: 2, language: 'ar' },
            { id: 'special-b', title: 'Special', position: 3, language: 'ar' }];
        f.manifests.get('manga')!.chapters = order === 'ascending' ? oldestFirst : [...oldestFirst].reverse();
        const manga = f.site.CreateEntry('manga', 'Manga');
        manga['scraper'].GetArchiveChapterOrder = () => ({ order, evidence: 'Isolated structured source order, after decorators' });
        const adapter = new EngineArchiveSource(f.site);
        f.source.Chapters = adapter.Chapters.bind(adapter);
        const result = await f.manager().Start();
        expect(f.calls).toEqual(['manga/old', 'manga/fraction', 'manga/special-a', 'manga/special-b']);
        expect(result.counts.healthy).toBe(4);
        expect(result.state).toBe('review'); // Local bytes are healthy; source coverage is still unproven.
    });

    it('Should reject an asserted direction without evidence', async () => {
        const f = await fixture();
        const manga = f.site.CreateEntry('manga', 'Manga');
        manga['scraper'].GetArchiveChapterOrder = () => ({ order: 'ascending', evidence: '  ' });
        expect((await new EngineArchiveSource(f.site).Chapters(manga, new AbortController().signal)).order).toBe('unknown');
    });

    it.each(['ascending', 'descending'] as const)('Should preserve explicit %s evidence without parsing titles or read markers', async order => {
        const f = await fixture();
        const manga = f.site.CreateEntry('manga', 'Manga');
        const scraper = manga['scraper'];
        scraper.GetArchiveChapterOrder = () => ({ order, evidence: 'Isolated connector response contract after decorators' });
        const manifest = await new EngineArchiveSource(f.site).Chapters(manga, new AbortController().signal);
        expect(manifest.order).toBe(order);
        expect(manifest.orderEvidence).toBe('Isolated connector response contract after decorators');
        expect(manifest.chapters.map(chapter => chapter.title)).toEqual(['Special', '1.5']);
    });

    it('Should require connector-specific order evidence and classify unsupported catalog access', async () => {
        const f = await fixture();
        const native = new EngineArchiveSource(f.site);
        const manga = f.site.CreateEntry('manga', 'Manga');
        const manifest = await native.Chapters(manga, new AbortController().signal);
        expect(manifest.order).toBe('unknown');
        expect(manifest.coverage.state).toBe('unknown');
        f.source.Catalog = async function* () { throw new Error('Not implemented: full index'); };
        const result = await f.manager().Start();
        expect(result.index.state).toBe('unsupported');
        expect(result.state).toBe('review');
        expect(f.calls).toEqual([]);
    });
});
