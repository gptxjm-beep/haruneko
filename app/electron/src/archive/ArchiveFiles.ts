import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, type Hash } from 'node:crypto';
import { open, copyFile, unlink, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { ArchiveRepository } from './ArchiveRepository';
import { Count, RelativePath, ResolveArchivePath, Fingerprint, SafeMessage, ErrorCode, ErrorMessage } from './ArchivePaths';
import type { ArchiveFileReceipt, ArchiveRecovery } from './ArchiveProtocol';
import type { ArchiveStorageController } from './ArchiveStorageController';
import { StorageFailure } from './ArchiveStorageContract';

type Write = { fileId: string; attemptId: string; size: number; received: number; hash: Hash; handle?: FileHandle; existing: boolean };
export type ArchiveFileCapacityGuard = (phase: 'before-staging' | 'before-publication', rootId: string, bytes: number) => Promise<void>;

/** Only app-owned staging files are writable. Publication always uses COPYFILE_EXCL. */
export class ArchiveFiles {
    private readonly writes = new Map<string, Write>();

    constructor(private readonly repository: ArchiveRepository, private readonly capacityGuard?: ArchiveFileCapacityGuard, private readonly storage?: ArchiveStorageController) {}

    public async Begin(attemptId: string, relative: string, size: number): Promise<string> {
        if (this.writes.size >= 32) throw new Error('Too many active archive writes');
        const attempt = this.repository.Attempt(attemptId, true);
        RelativePath(relative); Count(size, 'file size', 16 * 1024 ** 3);
        await this.storage?.CheckRoot(String(attempt.root_id));
        const root = this.repository.VerifyRoot(attempt.root_id);
        const target = await ResolveArchivePath(root, relative, true);
        let exists = false;
        try { await lstat(target); exists = true; } catch(error) { if (ErrorCode(error) !== 'ENOENT') throw error; }
        let file = this.repository.FindFile(attempt.root_id, relative);
        let reserved = false;
        try {
            if (file && file.path !== relative) throw new Error('Case or Unicode path alias requires review');
            if (exists && (!file || file.chapter_key !== attempt.chapter_key || file.state !== 'verified' || !file.sha256)) throw new Error('Existing output requires review; replacement is forbidden');
            file = this.repository.ReserveFile(attemptId, relative, size);
            const fileId = file.id;
            if (this.writes.values().some(write => write.fileId === fileId)) throw new Error('Archive file already has an active writer');
            const staging = path.join(this.repository.StagingDirectory, file.staging);
            const token = randomUUID();
            if (exists) {
                const actual = await Fingerprint(root, file.path);
                if (actual.size !== file.size || actual.sha256 !== file.sha256 || size !== file.size) throw new Error('Existing output differs from the expected file; review required');
                this.writes.set(token, { fileId: file.id, attemptId, size, received: 0, hash: createHash('sha256'), existing: true });
            } else {
                await this.capacityGuard?.('before-staging', attempt.root_id, size);
                await this.storage?.File(String(file.id), String(attempt.root_id), size);
                reserved = true;
                try { await lstat(staging); throw new Error('Interrupted staging file requires review or recovery'); }
                catch(error) { if (ErrorCode(error) !== 'ENOENT') throw error; }
                file = this.repository.ResetMissingFile(file.id, attemptId, size);
                this.repository.SetFileState(file.id, 'writing');
                const handle = await open(staging, 'wx', 0o600);
                this.writes.set(token, { fileId: file.id, attemptId, size, received: 0, hash: createHash('sha256'), handle, existing: false });
            }
            return token;
        } catch(error) {
            if (file && reserved) await this.storage?.ReleaseFile(String(file.id));
            const storageError = StorageFailure(error, 'staging');
            if (storageError) throw storageError;
            this.repository.Conflict(attemptId, relative, SafeMessage(ErrorMessage(error)));
            throw error;
        }
    }

    public async Chunk(token: string, bytes: Uint8Array): Promise<void> {
        const write = this.writes.get(token);
        if (!write) throw new Error('Unknown archive write');
        this.repository.Attempt(write.attemptId, true);
        if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 256 * 1024 || write.received + bytes.byteLength > write.size) throw new Error('Invalid archive chunk');
        if (write.handle) {
            const file = this.repository.File(write.fileId);
            await this.storage?.CheckChunk(write.fileId, String(file.root_id), write.size, write.received, bytes.byteLength);
            let offset = 0;
            while (offset < bytes.byteLength) {
                const result = await write.handle.write(bytes, offset, bytes.byteLength - offset, write.received + offset).catch(error => { throw StorageFailure(error, 'staging') ?? error; });
                if (!result.bytesWritten) throw new Error('Archive write made no progress');
                offset += result.bytesWritten;
            }
        }
        write.hash.update(bytes);
        write.received += bytes.byteLength;
    }

    public async Finish(token: string): Promise<ArchiveFileReceipt> {
        const write = this.writes.get(token);
        if (!write) throw new Error('Unknown archive write');
        this.repository.Attempt(write.attemptId, true);
        try {
            if (write.received !== write.size) throw new Error('Archive file is incomplete');
            const digest = write.hash.digest('hex');
            let file = this.repository.File(write.fileId);
            if (write.existing) {
                const actual = await Fingerprint(this.repository.VerifyRoot(file.root_id), file.path);
                if (digest !== file.sha256 || actual.sha256 !== digest || actual.size !== write.size) throw new Error('Existing output does not match this export; replacement is forbidden');
                this.repository.RecordFileReceipt(write.attemptId, file.id);
                return { fileId: file.id, rootId: file.root_id, path: file.path, size: actual.size, sha256: digest, reused: true };
            }
            if (!write.handle) throw new Error('Archive staging handle is unavailable');
            await write.handle.sync();
            await write.handle.close();
            write.handle = undefined;
            // Persist the digest BEFORE creating the final path. This is the recovery witness
            // for a crash after successful publication but before Completed/result recording.
            this.repository.SetFileState(file.id, 'staged', digest);
            file = this.repository.File(file.id);
            return await this.Publish(file.id);
        } catch(error) {
            const storageError = StorageFailure(error, 'publication');
            try { this.repository.Error(write.attemptId, 'export', SafeMessage(ErrorMessage(error))); }
            catch(recordError) { if (!storageError) throw recordError; }
            throw storageError ?? error;
        } finally {
            try { await write.handle?.close(); } finally { this.writes.delete(token); await this.storage?.ReleaseFile(write.fileId); }
        }
    }

    public async Abort(token: string): Promise<void> {
        const write = this.writes.get(token);
        if (!write) return;
        try {
            // Only an empty, still-open artifact owned by this attempt can be removed. Never a final output.
            if (write.handle && (await write.handle.stat()).size === 0) {
                const file = this.repository.File(write.fileId);
                const owned = await write.handle.stat({ bigint: true });
                const named = await lstat(path.join(this.repository.StagingDirectory, String(file.staging)), { bigint: true });
                if (!named.isSymbolicLink() && named.dev === owned.dev && named.ino === owned.ino && named.size === 0n) {
                    await write.handle.close(); write.handle = undefined;
                    await unlink(path.join(this.repository.StagingDirectory, String(file.staging)));
                    this.repository.ResetMissingFile(write.fileId, write.attemptId, write.size);
                }
            }
        } finally {
            try { await write.handle?.close(); }
            finally { this.writes.delete(token); await this.storage?.ReleaseFile(write.fileId); }
        }
        // Keep interrupted staging for inspection. Never unlink a final output on cancellation.
    }

    public async Close(): Promise<void> {
        const results = await Promise.allSettled([...this.writes.keys()].map(token => this.Abort(token)));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
    }

    public HasActive(sessionId: string): boolean {
        return this.writes.values().some(write => this.repository.Attempt(write.attemptId).session_id === sessionId);
    }

    public async Publish(fileId: string): Promise<ArchiveFileReceipt> {
        const file = this.repository.File(fileId);
        if (!file.sha256 || !file.staging) throw new Error('Staged file has no durable fingerprint');
        const root = this.repository.VerifyRoot(file.root_id);
        await this.capacityGuard?.('before-publication', file.root_id, Number(file.size));
        const staged = await Fingerprint(this.repository.StagingDirectory, file.staging);
        if (staged.size !== file.size || staged.sha256 !== file.sha256) throw new Error('Staging fingerprint mismatch');
        const target = await ResolveArchivePath(root, file.path, true);
        let alreadyPublished = false;
        try {
            try {
                const existing = await Fingerprint(root, file.path);
                if (existing.size !== file.size || existing.sha256 !== file.sha256) throw new Error('Existing output conflicts with staging; review required');
                alreadyPublished = true;
            } catch(error) { if (ErrorCode(error) !== 'ENOENT') throw error; }
            if (!alreadyPublished) {
                await this.storage?.File(String(file.id), String(file.root_id), Number(file.size));
                try { await copyFile(path.join(this.repository.StagingDirectory, file.staging), target, fs.constants.COPYFILE_EXCL); }
                catch(error) {
                    if (ErrorCode(error) !== 'EEXIST') throw StorageFailure(error, 'archive') ?? error;
                    const existing = await Fingerprint(root, file.path);
                    if (existing.size !== file.size || existing.sha256 !== file.sha256) throw new Error('Existing output conflicts with staging; review required');
                }
            }
            const published = await Fingerprint(root, file.path);
            if (published.size !== file.size || published.sha256 !== file.sha256) throw new Error('Published file fingerprint mismatch');
            const handle = await open(target, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
            try { await handle.sync(); } finally { await handle.close(); }
            this.repository.SetFileState(file.id, 'verified', published.sha256, published.stamp);
            this.repository.RecordFileReceipt(file.attempt_id, file.id);
            try { await unlink(path.join(this.repository.StagingDirectory, file.staging)); }
            catch(error) { if (ErrorCode(error) !== 'ENOENT') this.repository.Error(file.attempt_id, 'cleanup', 'Owned staging cleanup failed'); }
            return { fileId: file.id, rootId: file.root_id, path: file.path, size: published.size, sha256: published.sha256 };
        } finally { await this.storage?.ReleaseFile(String(file.id)); }
    }

    public async Inspect(sessionId: string, relative: string, hash = false): Promise<Record<string, unknown>> {
        const session = this.repository.Session(sessionId);
        const root = this.repository.VerifyRoot(session.root_id);
        const target = await ResolveArchivePath(root, relative);
        try {
            const info = await lstat(target);
            return { state: this.repository.FindFile(session.root_id, relative) ? 'tracked' : 'untracked', path: relative, size: info.size,
                ...hash ? { sha256: (await Fingerprint(root, relative)).sha256 } : {} };
        } catch(error) { if (ErrorCode(error) === 'ENOENT') return { state: 'missing', path: relative }; throw error; }
    }

    public async Recover(sessionId: string, chapterKey: string, fullAudit = false): Promise<ArchiveRecovery> {
        if (this.HasActive(sessionId)) throw new Error('Recovery cannot run during active writes');
        const data = this.repository.RecoveryData(sessionId, chapterKey);
        let root = this.repository.RootPath(data.session.root_id);
        const files: ArchiveRecovery['files'] = [];
        const stagingCleanup: string[] = [];
        try {
            root = this.repository.VerifyRoot(data.session.root_id);
            if (!(await lstat(root)).isDirectory()) throw new Error('Root unavailable');
        } catch {
            this.repository.SetRecovery(sessionId, chapterKey, 'uncertain', 'unknown');
            return { chapterKey, localState: 'uncertain', sourceState: 'unknown', action: 'review',
                files: data.files.map(file => ({ fileId: String(file.id), path: String(file.path), state: 'uncertain', checkedBy: 'root-unavailable' })), cleanup: data.cleanup, stagingCleanup };
        }
        for (const file of data.files) {
            let state = 'uncertain';
            let checkedBy = 'none';
            try {
                const target = await ResolveArchivePath(root, file.path);
                const stat = await lstat(target, { bigint: true });
                const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
                if (!file.expected_sha256) state = 'uncertain';
                else if (!fullAudit && file.state === 'verified' && file.expected_sha256 === file.sha256 && file.stamp === stamp && Number(stat.size) === Number(file.expected_size)) {
                    state = 'healthy'; checkedBy = 'metadata-cache';
                } else {
                    const actual = await Fingerprint(root, file.path);
                    checkedBy = 'sha256';
                    state = actual.size === Number(file.expected_size) && actual.sha256 === file.expected_sha256 ? 'healthy' : 'damaged';
                    if (state === 'healthy' && file.attempt_id === data.attempt?.id) {
                        this.repository.SetFileState(file.id, 'verified', actual.sha256, actual.stamp);
                        this.repository.RecordFileReceipt(file.attempt_id, file.id);
                    }
                }
            } catch(error) {
                if (ErrorCode(error) !== 'ENOENT') { state = 'uncertain'; checkedBy = 'unavailable'; }
                else {
                    state = file.state === 'planned' ? 'not-written' : 'missing';
                    if (file.staging) {
                        try {
                            const staged = await Fingerprint(this.repository.StagingDirectory, file.staging);
                            state = file.expected_sha256 && staged.sha256 === file.expected_sha256 && staged.size === Number(file.expected_size) ? 'staged' : 'partial';
                        } catch(stagingError) { if (ErrorCode(stagingError) !== 'ENOENT') state = 'uncertain'; }
                    }
                }
            }
            if (state === 'healthy' && file.staging) {
                try { await lstat(path.join(this.repository.StagingDirectory, file.staging)); stagingCleanup.push(String(file.id)); }
                catch { /* No owned staging artifact needs cleanup. */ }
            }
            files.push({ fileId: String(file.id), path: String(file.path), state, checkedBy });
        }
        const expected = Number(data.attempt?.expected_files ?? 0);
        const healthy = expected > 0 && files.length === expected && files.every(file => file.state === 'healthy') && !data.conflicts.length;
        let localState: ArchiveRecovery['localState'] = healthy ? 'healthy' : files.some(file => file.state === 'damaged') ? 'damaged'
            : files.some(file => file.state === 'healthy' || file.state === 'partial' || file.state === 'staged') ? 'partial'
                : files.some(file => file.state === 'uncertain') || data.conflicts.length || data.otherArtifacts ? 'uncertain'
                    : files.some(file => file.state === 'missing') ? 'missing' : 'not-written';
        if (healthy) localState = 'healthy';
        const sourceState: ArchiveRecovery['sourceState'] = healthy && data.attempt?.session_id === sessionId && data.chapter.expected_trusted
            && Number(data.chapter.expected_pages) === Number(data.attempt.validated_pages) ? 'complete' : 'unknown';
        const action: ArchiveRecovery['action'] = healthy ? 'reuse' : files.some(file => file.state === 'staged') && files.every(file => ['staged', 'healthy'].includes(file.state))
            ? 'publish-staged' : localState === 'not-written' || localState === 'missing' && files.every(file => file.state === 'missing' || file.state === 'not-written') ? 'retry-missing' : 'review';
        this.repository.SetRecovery(sessionId, chapterKey, localState, sourceState);
        return { chapterKey, localState, sourceState, action, files, cleanup: data.cleanup, stagingCleanup };
    }
}
