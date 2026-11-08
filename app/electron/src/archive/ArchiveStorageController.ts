import type { ArchiveRepository } from './ArchiveRepository';
import type { ArchiveStorageSafety} from './ArchiveStorageSafety';
import { type ArchiveStorageClaim } from './ArchiveStorageSafety';
import { ArchiveStorageError } from './ArchiveStorageContract';
import { Count } from './ArchivePaths';

export interface ArchiveStoragePaths { profile: string; browser: string; staging: string; scratch: string }
export interface ArchiveQuota { usage: number; quota: number }
const MiB = 1024 * 1024;

/** One instance shared by every archive session in the primary Electron window. */
export class ArchiveStorageController {
    private readonly attempts = new Map<string, { input: number; prepared: number }>();
    private readonly fileChecks = new Map<string, { bytes: number; time: number }>();
    constructor(private readonly repository: ArchiveRepository, private readonly paths: ArchiveStoragePaths, public readonly Safety: ArchiveStorageSafety) {}

    private Claims(rootId: string, input = 0, prepared = 0): ArchiveStorageClaim[] {
        const estimate = BigInt(Math.max(16 * MiB + input * 4, prepared * 2));
        return [
            { slot: 'ledger', location: 'database', path: this.paths.profile, bytes: 0n },
            { slot: 'images', location: 'indexeddb', path: this.paths.browser, bytes: BigInt(input) * 2n },
            { slot: 'blob', location: 'preparation', path: this.paths.browser, bytes: estimate },
            { slot: 'scratch', location: 'system-temporary', path: this.paths.scratch, bytes: estimate },
            { slot: 'stage', location: 'staging', path: this.paths.staging, bytes: estimate },
            { slot: 'final', location: 'archive', path: this.repository.RootPath(rootId), bytes: estimate, expectedIdentity: this.repository.RootStorageIdentity(rootId) },
        ];
    }

    public async CheckSession(sessionId: string, metadataBytes = 0n): Promise<void> {
        const session = this.repository.Session(sessionId);
        const claims = this.Claims(String(session.root_id));
        claims[0].bytes = metadataBytes;
        await this.Safety.Check(claims);
    }

    /** Optional manga metadata is written on the final archive volume, independently of browser/profile disks. */
    public async Metadata(sessionId: string, bytes: number): Promise<void> {
        const session = this.repository.Session(sessionId), claims = this.Claims(String(session.root_id));
        claims.at(-1)!.bytes = BigInt(Count(bytes, 'metadata bytes', 16 * 1024 ** 2));
        await this.Safety.Check(claims);
    }

    public async Image(attemptId: string, bytes: number, quota: ArchiveQuota, preflight = false): Promise<void> {
        Count(bytes, 'temporary bytes', Number.MAX_SAFE_INTEGER);
        if (!quota || !Number.isSafeInteger(quota.usage) || !Number.isSafeInteger(quota.quota) || quota.usage < 0 || quota.quota < quota.usage) throw new ArchiveStorageError({ code: 'unmeasurable', location: 'indexeddb-quota' });
        const current = this.attempts.get(attemptId) ?? { input: 0, prepared: 0 };
        const next = { ...current, input: Count(current.input + bytes, 'temporary byte budget', Number.MAX_SAFE_INTEGER / 16) };
        const attempt = this.repository.Attempt(attemptId, true);
        await this.Safety.Check(this.Claims(String(attempt.root_id), current.input, current.prepared));
        const held = [...this.attempts].filter(([id]) => id !== attemptId).reduce((sum, [, value]) => sum + BigInt(value.input) * 2n, 0n);
        const required = held + BigInt(next.input) * 2n + BigInt(8 * MiB);
        if (BigInt(quota.quota - quota.usage) < required) throw new ArchiveStorageError({ code: 'quota-exceeded', location: 'indexeddb-quota', usableBytes: String(quota.quota - quota.usage), requiredBytes: String(required) });
        await this.Safety.Reserve(`attempt:${attemptId}`, this.Claims(String(attempt.root_id), next.input, next.prepared));
        if (!preflight) this.attempts.set(attemptId, next);
    }

    public async Prepare(attemptId: string, bytes: number): Promise<void> {
        Count(bytes, 'preparation bytes', Number.MAX_SAFE_INTEGER / 16);
        const previous = this.attempts.get(attemptId) ?? { input: 0, prepared: 0 };
        const next = { ...previous, prepared: Math.max(previous.prepared, bytes) };
        const attempt = this.repository.Attempt(attemptId, true);
        await this.Safety.Reserve(`attempt:${attemptId}`, this.Claims(String(attempt.root_id), next.input, next.prepared));
        this.attempts.set(attemptId, next);
    }

    public async CheckRoot(rootId: string): Promise<void> { await this.Safety.Check(this.Claims(rootId)); }

    public async File(fileId: string, rootId: string, bytes: number): Promise<void> {
        Count(bytes, 'output bytes', Number.MAX_SAFE_INTEGER);
        await this.Safety.Reserve(`file:${fileId}`, [
            { slot: 'stage', location: 'staging', path: this.paths.staging, bytes: BigInt(bytes) },
            { slot: 'final', location: 'archive', path: this.repository.RootPath(rootId), bytes: BigInt(bytes), expectedIdentity: this.repository.RootStorageIdentity(rootId) },
        ]);
        this.fileChecks.set(fileId, { bytes: 0, time: Date.now() });
    }

    public async CheckChunk(fileId: string, rootId: string, size: number, received: number, chunk: number): Promise<void> {
        const previous = this.fileChecks.get(fileId);
        if (!previous || received - previous.bytes >= MiB || Date.now() - previous.time >= 250 || received + chunk >= size) {
            await this.File(fileId, rootId, size);
            this.fileChecks.set(fileId, { bytes: received, time: Date.now() });
        }
    }

    public async ReleaseFile(fileId: string): Promise<void> { this.fileChecks.delete(fileId); await this.Safety.Release(`file:${fileId}`); }
    public async ReleaseAll(): Promise<void> { this.attempts.clear(); this.fileChecks.clear(); await this.Safety.ReleaseAll(); }
    public async ReleaseAttempt(attemptId: string): Promise<void> {
        this.attempts.delete(attemptId);
        await this.Safety.Release(`attempt:${attemptId}`);
    }
}
