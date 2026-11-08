import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ArchiveRepository } from '../app/electron/src/archive/ArchiveRepository.ts';
import { ArchiveFiles } from '../app/electron/src/archive/ArchiveFiles.ts';
import { MigrateArchiveDatabase } from '../app/electron/src/archive/ArchiveSchema.ts';
import { RelativePath } from '../app/electron/src/archive/ArchivePaths.ts';
import { ProbeArchiveVolume, DefaultArchiveStoragePolicy } from '../app/electron/src/archive/ArchiveStorageSafety.ts';

const registration = (chapterId = 'chapter', trusted = false) => ({ siteId: 'site', mangaId: 'manga', chapterId, title: 'Same title', position: 0,
    orderConfidence: 'connector-contract', orderEvidence: 'Fixture source order', expectedPages: 1, expectedPagesTrusted: trusted,
    expectedPagesEvidence: trusted ? 'Fixture manifest v1' : '' });
const result = overrides => ({ outcome: 'succeeded', receivedPages: 1, validatedPages: 1, outputState: 'written', verification: 'passed', cleanupState: 'completed', cleanupKeys: [], errors: [], ...overrides });

async function fixture() {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-archive-case-'));
    const root = path.join(base, 'output');
    await fs.mkdir(root);
    const filename = path.join(base, 'profile', 'state.sqlite');
    const repository = new ArchiveRepository(filename);
    const files = new ArchiveFiles(repository);
    const grant = repository.GrantRoot(root);
    const session = repository.CreateSession(grant.rootId, 'site', 'Fixture site', { format: 'application/x-cbz', useWebsiteSubDirectory: false });
    const chapter = repository.RegisterChapter(session, registration());
    return { base, root, filename, repository, files, grant, session, chapter, async close() { await files.Close(); repository.Close(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function begin(f, relative = 'Manga/chapter.cbz', bytes = Buffer.from('data')) {
    const attempt = f.repository.BeginAttempt(f.session, f.chapter);
    f.repository.Checkpoint(attempt, 'export', 1, 1, 1);
    const token = await f.files.Begin(attempt, relative, bytes.length);
    await f.files.Chunk(token, bytes);
    return { attempt, token, bytes };
}

async function write(f, relative = 'Manga/chapter.cbz', bytes = Buffer.from('data'), finish = true) {
    const started = await begin(f, relative, bytes);
    const receipt = await f.files.Finish(started.token);
    if (finish) f.repository.FinishAttempt(started.attempt, result());
    return { ...started, receipt };
}

if (process.argv[2] === 'crash-child') {
    const [filename, session, chapter, phase] = process.argv.slice(3);
    const repository = new ArchiveRepository(filename);
    const files = new ArchiveFiles(repository);
    if (phase.startsWith('queue-')) {
        const reference = { siteId: 'queue-site', mangaId: 'queue-manga', title: 'Queue manga', siteName: 'Queue site' };
        repository.Queue.Execute({ operation: 'queue-select', reference, selected: true });
        repository.Queue.Execute({ operation: 'queue-add' });
        if (phase !== 'queue-added') {
            const preferences = { ...repository.UI.Preferences(), rootId: repository.Session(session).root_id };
            repository.Queue.Execute({ operation: 'queue-open', preferences, confirmed: true });
            const item = repository.Queue.Execute({ operation: 'queue-next' });
            repository.Queue.Execute({ operation: 'queue-add', reference: { ...reference, mangaId: 'late-after-confirmation', title: 'Later queue addition' } });
            if (phase === 'queue-verified') {
                const sessionId = item.sessionId, mangaId = item.mangaId;
                repository.Work.Execute({ operation: 'archive-run-open', sessionId, policy: preferences.policy });
                repository.Work.Execute({ operation: 'archive-manga-begin', sessionId, mangaId });
                repository.Work.Execute({ operation: 'archive-manga-list', sessionId, mangaId, chapters: [{ id: 'owned', title: 'Owned', position: 0, language: 'ar' }], order: 'ascending', orderEvidence: 'Isolated crash fixture', evidence: { state: 'unknown', evidence: 'Fixture' } });
                const work = repository.Work.Execute({ operation: 'archive-next-chapter', sessionId, mangaId, now: Date.now() });
                repository.Work.Execute({ operation: 'archive-chapter-begin', sessionId, mangaId, chapterId: 'owned' });
                const attempt = repository.BeginAttempt(sessionId, work.chapter_key);
                repository.Checkpoint(attempt, 'export', 1, 1, 1);
                const writeId = await files.Begin(attempt, 'Queue/verified.cbz', 4); await files.Chunk(writeId, Buffer.from('data')); await files.Finish(writeId);
            }
        }
    } else if (['coordinator', 'manifest', 'catalog'].includes(phase)) {
        const policy = { maxMangas: 1, maxChapters: 2, delayMs: 100, retryDelayMs: 1000, maxAttempts: 2, languages: [], unknownLanguage: 'include' };
        const command = input => repository.Work.Execute({ sessionId: session, ...input });
        command({ operation: 'archive-run-open', policy });
        command({ operation: 'archive-catalog-begin' });
        command({ operation: 'archive-catalog-page', items: [{ id: 'manga', title: 'Manga' }] });
        if (phase !== 'catalog') {
            command({ operation: 'archive-catalog-end', index: { state: 'unknown', evidence: 'Crash fixture' } });
            command({ operation: 'archive-manga-begin', mangaId: 'manga' });
            if (phase === 'manifest') {
                const token = command({ operation: 'archive-manifest-begin', mangaId: 'manga', count: 364, order: 'ascending', orderEvidence: 'Fixture', evidence: { state: 'unknown', evidence: '' } });
                command({ operation: 'archive-manifest-batch', mangaId: 'manga', manifestId: token, offset: 0,
                    chapters: Array.from({ length: 200 }, (_, position) => ({ id: position ? `c${position}` : 'stale', title: `C${position}`, position, language: null })) });
            } else {
                command({ operation: 'archive-manga-list', mangaId: 'manga', chapters: [{ id: 'chapter', title: 'Chapter', position: 0, language: null }],
                    order: 'ascending', orderEvidence: 'Crash fixture order', evidence: { state: 'unknown', evidence: '' } });
                command({ operation: 'archive-chapter-begin', mangaId: 'manga', chapterId: 'chapter' });
            }
        }
    } else if (phase === 'transaction') {
        repository.database.exec('BEGIN IMMEDIATE');
        repository.database.prepare('UPDATE sessions SET site_name=? WHERE id=?').run('Uncommitted name', session);
    } else {
        const attempt = repository.BeginAttempt(session, chapter);
        if (phase === 'fetch') repository.Checkpoint(attempt, 'fetch', 0, 0);
        else {
            repository.Checkpoint(attempt, 'export', 1, 1, 1);
            const token = await files.Begin(attempt, 'Manga/crash.cbz', 4);
            await files.Chunk(token, Buffer.from(phase === 'writing' ? 'd' : 'data'));
            if (phase === 'verified') await files.Finish(token);
            else if (phase === 'staged' || phase === 'published') {
                const pending = files.writes.get(token);
                await pending.handle.sync();
                await pending.handle.close();
                pending.handle = undefined;
                repository.SetFileState(pending.fileId, 'staged', createHash('sha256').update('data').digest('hex'));
                const file = repository.File(pending.fileId);
                if (phase === 'published') {
                    const root = repository.RootPath(file.root_id);
                    await fs.copyFile(path.join(repository.StagingDirectory, file.staging), path.join(root, file.path), 1);
                }
            }
        }
    }
    process.stdout.write('READY\n');
    setInterval(() => {}, 1000);
} else {
    let passed = 0;
    async function check(name, test) {
        await test(); passed++;
        console.log(`PASS ${name}`);
    }

    await check('The installed Electron measures free and caller-usable filesystem capacity', async () => {
        const f = await fixture();
        try {
            const sample = await ProbeArchiveVolume(f.root);
            const stage = await ProbeArchiveVolume(f.repository.StagingDirectory);
            assert.equal(typeof sample.usableBytes, 'bigint');
            assert.ok(sample.freeBytes >= sample.usableBytes);
            assert.equal(sample.volume, stage.volume);
            assert.equal(DefaultArchiveStoragePolicy.reserveBytes, 50n * 1024n ** 3n);
        } finally { await f.close(); }
    });

    await check('SQLite is supported by the installed Electron runtime', async () => {
        assert.equal(process.versions.electron, '45.2.2');
        const db = new DatabaseSync(':memory:');
        console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, sqlite: db.prepare('SELECT sqlite_version() AS version').get().version }));
        db.close();
    });

    await check('Archiving defaults and prepared sessions survive repository reopen without auto-start', async () => {
        const f = await fixture();
        try {
            const value = f.repository.UI.Preferences();
            value.rootId = f.grant.rootId; value.policy.delayMs = 2000;
            f.repository.UI.Save(value);
            const id = f.repository.UI.Create('ui-fixture', 'UI fixture', value, true);
            f.repository.Close();
            const reopened = new ArchiveRepository(f.filename);
            try {
                assert.equal(reopened.UI.Preferences().policy.delayMs, 2000);
                assert.equal(reopened.UI.Session(id).snapshot.state, 'paused');
                assert.equal(reopened.UI.Session(id).snapshot.chaptersStarted, 0);
            } finally { reopened.Close(); }
        } finally { await f.close(); }
    });

    await check('Session identity and chapter ordering survive reopen', async () => {
        const f = await fixture();
        try {
            f.repository.SetSessionState(f.session, 'paused');
            f.repository.Close();
            const reopened = new ArchiveRepository(f.filename);
            try {
                assert.equal(reopened.Session(f.session).state, 'paused');
                assert.equal(reopened.RegisterChapter(f.session, registration()), f.chapter);
                assert.equal(reopened.Chapter(f.session, f.chapter).order_confidence, 'connector-contract');
                assert.notEqual(reopened.RegisterChapter(f.session, registration('different-id')), f.chapter);
            } finally { reopened.Close(); }
        } finally { await f.close(); }
    });

    await check('Written bytes and SHA-256 persist without treating unknown source as complete', async () => {
        const f = await fixture();
        try {
            const written = await write(f);
            assert.equal(written.receipt.sha256, createHash('sha256').update('data').digest('hex'));
            const recovered = await f.files.Recover(f.session, f.chapter, true);
            assert.equal(recovered.localState, 'healthy');
            assert.equal(recovered.sourceState, 'unknown');
            assert.notEqual(f.repository.Chapter(f.session, f.chapter).state, 'Completed');
            assert.equal(f.repository.Session(f.session).index_state, 'unknown');
        } finally { await f.close(); }
    });

    for (const kind of ['deleted', 'different-size', 'same-size-corrupt']) {
        await check(`Completed local output detects ${kind}`, async () => {
            const f = await fixture();
            try {
                f.repository.RegisterChapter(f.session, registration('chapter', true));
                await write(f);
                await f.files.Recover(f.session, f.chapter, true);
                assert.equal(f.repository.Chapter(f.session, f.chapter).state, 'Completed');
                const target = path.join(f.root, 'Manga/chapter.cbz');
                if (kind === 'deleted') await fs.unlink(target);
                else await fs.writeFile(target, kind === 'different-size' ? 'longer-data' : 'evil');
                const recovered = await f.files.Recover(f.session, f.chapter, true);
                assert.equal(recovered.localState, kind === 'deleted' ? 'missing' : 'damaged');
                assert.notEqual(f.repository.Chapter(f.session, f.chapter).state, 'Completed');
            } finally { await f.close(); }
        });
    }

    await check('Untracked existing files are reported and never replaced', async () => {
        const f = await fixture();
        try {
            await fs.writeFile(path.join(f.root, 'old.cbz'), 'old-user-file');
            assert.equal((await f.files.Inspect(f.session, 'old.cbz', true)).state, 'untracked');
            const attempt = f.repository.BeginAttempt(f.session, f.chapter);
            f.repository.Checkpoint(attempt, 'export', 1, 1, 1);
            await assert.rejects(f.files.Begin(attempt, 'old.cbz', 4), /review/);
            assert.equal(await fs.readFile(path.join(f.root, 'old.cbz'), 'utf8'), 'old-user-file');
            assert.equal((await f.files.Recover(f.session, f.chapter)).action, 'review');
        } finally { await f.close(); }
    });

    await check('New sessions reuse healthy old artifacts without claiming current source completeness', async () => {
        const f = await fixture();
        try {
            await write(f);
            const session = f.repository.CreateSession(f.grant.rootId, 'site', 'Fixture site', { format: 'application/x-cbz', useWebsiteSubDirectory: false });
            const key = f.repository.RegisterChapter(session, registration());
            const recovery = await f.files.Recover(session, key);
            assert.equal(recovery.action, 'reuse');
            assert.equal(recovery.sourceState, 'unknown');
        } finally { await f.close(); }
    });

    await check('A different directory organization is an independent output plan', async () => {
        const f = await fixture();
        try {
            await write(f);
            const session = f.repository.CreateSession(f.grant.rootId, 'site', 'Fixture site', { format: 'application/x-cbz', useWebsiteSubDirectory: true });
            const key = f.repository.RegisterChapter(session, registration());
            assert.equal((await f.files.Recover(session, key)).action, 'retry-missing');
        } finally { await f.close(); }
    });

    await check('An empty interrupted retry cannot hide previously written artifacts', async () => {
        const f = await fixture();
        try {
            await write(f);
            const attempt = f.repository.BeginAttempt(f.session, f.chapter);
            f.repository.Checkpoint(attempt, 'export', 1, 1, 1);
            f.repository.FinishAttempt(attempt, result({ outcome: 'failed', outputState: 'not-started' }));
            assert.equal((await f.files.Recover(f.session, f.chapter)).action, 'review');
            assert.equal(await fs.readFile(path.join(f.root, 'Manga/chapter.cbz'), 'utf8'), 'data');
        } finally { await f.close(); }
    });

    await check('Different chapter identities and case aliases cannot steal an existing filename', async () => {
        const f = await fixture();
        try {
            await write(f);
            const other = f.repository.RegisterChapter(f.session, registration('other-chapter'));
            const attempt = f.repository.BeginAttempt(f.session, other);
            f.repository.Checkpoint(attempt, 'export', 1, 1, 1);
            await assert.rejects(f.files.Begin(attempt, 'Manga/chapter.cbz', 4), /review/);
            const again = f.repository.BeginAttempt(f.session, f.chapter);
            f.repository.Checkpoint(again, 'export', 1, 1, 1);
            await assert.rejects(f.files.Begin(again, 'Manga/CHAPTER.cbz', 4), /alias/);
            assert.equal(await fs.readFile(path.join(f.root, 'Manga/chapter.cbz'), 'utf8'), 'data');
        } finally { await f.close(); }
    });

    await check('An explicit repeated export verifies bytes instead of replacing existing content', async () => {
        const f = await fixture();
        try {
            await write(f);
            const repeated = await write(f);
            assert.equal(repeated.receipt.reused, true);
            const changed = await begin(f, 'Manga/chapter.cbz', Buffer.from('evil'));
            await assert.rejects(f.files.Finish(changed.token), /replacement is forbidden/);
            assert.equal(await fs.readFile(path.join(f.root, 'Manga/chapter.cbz'), 'utf8'), 'data');
        } finally { await f.close(); }
    });

    await check('Cleanup failure keeps a healthy artifact and its owned cleanup keys', async () => {
        const f = await fixture();
        try {
            const written = await write(f, 'Manga/chapter.cbz', Buffer.from('data'), false);
            f.repository.FinishAttempt(written.attempt, result({ outcome: 'succeeded-with-warnings', cleanupState: 'failed', cleanupKeys: ['owned-key'], errors: [{ stage: 'cleanup', message: 'Failed https://example.invalid/x?token=secret cookie=value' }] }));
            const recovery = await f.files.Recover(f.session, f.chapter);
            assert.equal(recovery.action, 'reuse');
            assert.deepEqual(recovery.cleanup[0].keys, ['owned-key']);
            assert.throws(() => f.repository.RecordCleanup(written.attempt, ['foreign-key']), /does not own/);
            f.repository.RecordCleanup(written.attempt, []);
            assert.equal((await f.files.Recover(f.session, f.chapter)).cleanup.length, 0);
            const message = f.repository.database.prepare('SELECT message FROM errors LIMIT 1').get().message;
            assert.ok(!message.includes('token=secret') && !message.includes('cookie=value'));
        } finally { await f.close(); }
    });

    await check('Missing archive root is uncertain, not permission to redownload', async () => {
        const f = await fixture();
        try {
            await write(f);
            await fs.rename(f.root, f.root + '-offline');
            assert.equal((await f.files.Recover(f.session, f.chapter)).action, 'review');
        } finally { await f.close(); }
    });

    await check('Traversal, device names, symlink parents and overlapping grants are rejected', async () => {
        for (const name of ['../escape', '/absolute', 'C:/escape', 'a\\escape', 'a/../b', 'CON.txt', 'trailing.']) assert.throws(() => RelativePath(name));
        const f = await fixture();
        try {
            const outside = path.join(f.base, 'outside');
            await fs.mkdir(outside);
            await fs.symlink(outside, path.join(f.root, 'link'), 'dir');
            const attempt = f.repository.BeginAttempt(f.session, f.chapter);
            f.repository.Checkpoint(attempt, 'export', 1, 1, 1);
            await assert.rejects(f.files.Begin(attempt, 'link/escape.cbz', 4), /Unsafe/);
            assert.deepEqual(await fs.readdir(outside), []);
            await fs.mkdir(path.join(f.root, 'nested'));
            assert.throws(() => f.repository.GrantRoot(path.join(f.root, 'nested')), /Overlapping/);
            assert.throws(() => new ArchiveRepository(f.filename), /already open/);
        } finally { await f.close(); }
    });

    await check('Failed chapter transaction rolls back its stable-identity insertion', async () => {
        const f = await fixture();
        try {
            const before = f.repository.database.prepare('SELECT count(*) AS n FROM chapters').get().n;
            f.repository.database.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON session_chapters BEGIN SELECT RAISE(ABORT,'Injected transaction failure'); END;");
            assert.throws(() => f.repository.RegisterChapter(f.session, registration('rollback-me')), /Injected/);
            assert.equal(f.repository.database.prepare('SELECT count(*) AS n FROM chapters').get().n, before);
        } finally { await f.close(); }
    });

    await check('Schema v1 migrates transactionally and a failed migration preserves its version', async () => {
        const base = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-migration-'));
        const filename = path.join(base, 'state.sqlite');
        try {
            let db = new DatabaseSync(filename);
            MigrateArchiveDatabase(db, 1);
            db.exec('ALTER TABLE attempt_files ADD COLUMN receipt_size INTEGER');
            db.close();
            assert.throws(() => new ArchiveRepository(filename), /duplicate column/);
            db = new DatabaseSync(filename);
            assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
            assert.ok(!db.prepare('PRAGMA table_info(files)').all().some(row => row.name === 'verified_at'));
            db.exec('ALTER TABLE attempt_files DROP COLUMN receipt_size');
            db.close();
            const upgraded = new ArchiveRepository(filename);
            assert.equal(upgraded.database.prepare('PRAGMA user_version').get().user_version, 11);
            upgraded.Close();
        } finally { await fs.rm(base, { recursive: true, force: true }); }
    });

    for (const phase of ['transaction', 'fetch', 'writing', 'staged', 'published', 'verified', 'coordinator', 'manifest', 'catalog', 'queue-added', 'queue-prepared', 'queue-verified']) {
        await check(`SIGKILL recovery after ${phase}`, async () => {
            const f = await fixture();
            try {
                f.repository.RegisterChapter(f.session, registration('chapter', true));
                f.repository.Close();
                const child = spawn(process.execPath, [process.argv[1], 'crash-child', f.filename, f.session, f.chapter, phase], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
                let errors = '';
                child.stderr.on('data', chunk => { errors += chunk; });
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Crash fixture timed out: ' + errors)); }, 10_000);
                    child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) { clearTimeout(timeout); resolve(); } });
                    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Crash fixture exited ${code}: ${errors}`)); });
                    child.once('error', error => { clearTimeout(timeout); reject(error); });
                });
                const exited = new Promise(resolve => child.once('exit', resolve));
                child.kill('SIGKILL');
                await exited;
                const recovered = new ArchiveRepository(f.filename);
                const files = new ArchiveFiles(recovered);
                try {
                    assert.equal(recovered.Session(f.session).state, 'interrupted');
                    if (phase.startsWith('queue-')) {
                        const summary = recovered.Queue.Summary(), previous = recovered.Queue.Execute({ operation: 'queue-list' })[0];
                        if (phase !== 'queue-added') assert.equal(summary.waitingNextRun, 1);
                        assert.equal(recovered.Queue.Execute({ operation: 'queue-selections' }).length, 1);
                        assert.equal(summary.state, phase === 'queue-added' ? 'Paused' : 'Interrupted');
                        assert.equal(summary.chaptersStarted, phase === 'queue-verified' ? 1 : 0);
                        const preferences = summary.preferences ?? { ...recovered.UI.Preferences(), rootId: f.grant.rootId };
                        recovered.Queue.Execute({ operation: 'queue-open', preferences, confirmed: true });
                        const resumed = recovered.Queue.Execute({ operation: 'queue-next' });
                        assert.equal(recovered.Queue.Execute({ operation: 'queue-next' }).sessionId, resumed.sessionId);
                        if (phase !== 'queue-added') {
                            assert.equal(recovered.Queue.Summary().batchId, summary.batchId);
                            const late = recovered.Queue.Execute({ operation: 'queue-list' }).find(row => row.mangaId === 'late-after-confirmation');
                            assert.equal(late.sessionId, null); assert.equal(late.inCurrentRun, false);
                        }
                        if (previous.sessionId) assert.equal(resumed.sessionId, previous.sessionId);
                        assert.equal(recovered.database.prepare('SELECT count(*) n FROM sessions').get().n, 2);
                        if (phase === 'queue-verified') {
                            const chapterKey = recovered.database.prepare('SELECT chapter_key FROM archive_work WHERE session_id=?').get(resumed.sessionId).chapter_key;
                            assert.equal((await files.Recover(resumed.sessionId, chapterKey, true)).action, 'reuse');
                            assert.equal(await fs.readFile(path.join(f.root, 'Queue/verified.cbz'), 'utf8'), 'data');
                        }
                    }
                    if (phase === 'transaction') assert.equal(recovered.Session(f.session).site_name, 'Fixture site');
                    if (phase === 'catalog') {
                        const snapshot = recovered.Work.Snapshot(f.session);
                        assert.equal(snapshot.catalogState, 'interrupted');
                        assert.equal(snapshot.catalogDone, false);
                        assert.equal(snapshot.catalogAttempts, 0);
                        assert.equal(snapshot.index.state, 'partial');
                    }
                    if (phase === 'manifest') {
                        const snapshot = recovered.Work.Snapshot(f.session);
                        assert.equal(recovered.database.prepare('SELECT listed FROM archive_mangas').get().listed, 0);
                        assert.equal(recovered.database.prepare('SELECT received_count FROM archive_manifests').get().received_count, 200);
                        assert.equal(recovered.database.prepare('SELECT count(*) AS n FROM archive_work').get().n, 0);
                        const command = input => recovered.Work.Execute({ sessionId: f.session, ...input });
                        command({ operation: 'archive-run-open', policy: snapshot.policy });
                        assert.equal(command({ operation: 'archive-next-chapter', mangaId: 'manga', now: Date.now() }), null);
                        command({ operation: 'archive-manga-begin', mangaId: 'manga' });
                        const token = command({ operation: 'archive-manifest-begin', mangaId: 'manga', count: 364, order: 'ascending', orderEvidence: 'Fixture after restart', evidence: { state: 'unknown', evidence: '' } });
                        for (let offset = 0; offset < 364; offset += 200) command({ operation: 'archive-manifest-batch', mangaId: 'manga', manifestId: token, offset,
                            chapters: Array.from({ length: Math.min(200, 364 - offset) }, (_, index) => ({ id: `c${offset + index}`, title: `C${offset + index}`, position: offset + index, language: null })) });
                        command({ operation: 'archive-manifest-end', mangaId: 'manga', manifestId: token });
                        assert.equal(recovered.database.prepare('SELECT count(*) AS n FROM archive_work').get().n, 364);
                        assert.equal(recovered.database.prepare("SELECT id FROM archive_work WHERE id='stale'").get(), undefined);
                        assert.equal(command({ operation: 'archive-next-chapter', mangaId: 'manga', now: Date.now() }).id, 'c0');
                        assert.equal(recovered.Work.Snapshot(f.session).chaptersStarted, 0);
                    }
                    if (phase === 'coordinator') {
                        const snapshot = recovered.Work.Snapshot(f.session);
                        assert.equal(snapshot.state, 'interrupted');
                        assert.equal(snapshot.chaptersStarted, 1);
                        recovered.Work.Execute({ operation: 'archive-run-open', sessionId: f.session, policy: snapshot.policy });
                        const next = recovered.Work.Execute({ operation: 'archive-next-chapter', sessionId: f.session, mangaId: 'manga', now: Date.now() });
                        assert.equal(next.id, 'chapter');
                        assert.equal(next.state, 'pending');
                    }
                    const decision = await files.Recover(f.session, f.chapter, true);
                    if (phase === 'staged') {
                        assert.equal(decision.action, 'publish-staged');
                        await files.Publish(decision.files[0].fileId);
                        assert.equal((await files.Recover(f.session, f.chapter, true)).localState, 'healthy');
                    } else if (phase === 'published' || phase === 'verified') {
                        assert.equal(decision.action, 'reuse');
                        assert.equal(decision.sourceState, 'complete');
                        assert.equal(await fs.readFile(path.join(f.root, 'Manga/crash.cbz'), 'utf8'), 'data');
                    } else if (phase === 'writing') assert.equal(decision.action, 'review');
                    else assert.notEqual(recovered.Chapter(f.session, f.chapter).state, 'Completed');
                } finally { await files.Close(); recovered.Close(); }
            } finally { await f.close(); }
        });
    }
    console.log(`${passed} Electron SQLite/recovery checks passed`);
}
