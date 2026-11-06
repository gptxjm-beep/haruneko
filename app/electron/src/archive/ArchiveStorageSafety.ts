import { access, realpath, stat, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ArchiveStorageError, StorageFailure } from './ArchiveStorageContract';

export const DefaultArchiveStoragePolicy = Object.freeze({ reserveBytes: 50n * 1024n ** 3n, metadataHeadroomBytes: 64n * 1024n ** 2n });
export type ArchiveStoragePolicy = typeof DefaultArchiveStoragePolicy;
export interface ArchiveVolumeSample { volume: string; identity: string; freeBytes: bigint; usableBytes: bigint }
export interface ArchiveStorageClaim { slot: string; location: string; path: string; bytes: bigint; expectedIdentity?: string }
export type ArchiveVolumeProbe = (path: string) => Promise<ArchiveVolumeSample>;

/** libuv filesystem calls, never a shell command, directory crawl, or synchronous capacity scan. */
export async function ProbeArchiveVolume(directory: string): Promise<ArchiveVolumeSample> {
    const canonical = await realpath(directory);
    const [info, space] = await Promise.all([stat(canonical, { bigint: true }), statfs(canonical, { bigint: true })]);
    await access(canonical, constants.W_OK);
    if (!info.isDirectory() || space.bsize <= 0n || space.bavail < 0n || space.bfree < 0n) throw new Error('Filesystem capacity is unavailable');
    return { volume: `dev:${info.dev}`, identity: `${info.dev}:${info.ino}`, freeBytes: space.bfree * space.bsize,
        usableBytes: (space.bavail < space.bfree ? space.bavail : space.bfree) * space.bsize };
}

/** Process-local reservations are conservative promises, not physical allocations or protection from other applications. */
export class ArchiveStorageSafety {
    private readonly owners = new Map<string, Map<string, ArchiveStorageClaim>>();
    private readonly identities = new Map<string, string>();
    private serial: Promise<unknown> = Promise.resolve();

    constructor(private policy: ArchiveStoragePolicy = DefaultArchiveStoragePolicy, private readonly probe: ArchiveVolumeProbe = ProbeArchiveVolume) {
        if (policy.reserveBytes < 0n || policy.metadataHeadroomBytes < 0n) throw new Error('Invalid archive storage policy');
    }

    public get Policy(): ArchiveStoragePolicy { return this.policy; }

    /** Called only by the serialized main-process preferences command, with no open runs or reservations. */
    public ConfigureReserve(bytes: bigint): void {
        if (bytes < 50n * 1024n ** 3n || bytes > 4096n * 1024n ** 3n || this.owners.size) throw new Error('Storage reserve cannot change while writes are reserved');
        this.policy = Object.freeze({ ...this.Policy, reserveBytes: bytes });
    }

    public async ReleaseAll(): Promise<void> {
        const operation = this.serial.then(() => { this.owners.clear(); });
        this.serial = operation.catch(() => {});
        await operation;
    }

    public Reserve(owner: string, claims: ArchiveStorageClaim[]): Promise<void> {
        const operation = this.serial.then(async () => {
            const candidate = new Map(this.owners.get(owner));
            for (const claim of claims) {
                if (typeof claim.bytes !== 'bigint' || claim.bytes < 0n || !claim.slot || !claim.path) throw new Error('Invalid storage claim');
                candidate.set(claim.slot, { ...claim });
            }
            const all = [...this.owners.entries()].filter(([key]) => key !== owner).map(([, value]) => value);
            all.push(candidate);
            const samples = new Map<string, ArchiveVolumeSample>();
            const volumes = new Map<string, { bytes: bigint; sample: ArchiveVolumeSample; locations: Set<string> }>();
            for (const entries of all) for (const claim of entries.values()) {
                let sample = samples.get(claim.path);
                if (!sample) {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        sample = await Promise.race([this.probe(claim.path), new Promise<ArchiveVolumeSample>((_resolve, reject) => {
                            timer = setTimeout(() => reject(new ArchiveStorageError({ code: 'unmeasurable', location: claim.location, systemCode: 'MEASUREMENT_TIMEOUT' })), 5000);
                        })]);
                    }
                    catch(error) { throw StorageFailure(error, claim.location) ?? new ArchiveStorageError({ code: 'unmeasurable', location: claim.location }); }
                    finally { clearTimeout(timer); }
                    if (!sample.volume || !sample.identity || typeof sample.usableBytes !== 'bigint' || typeof sample.freeBytes !== 'bigint'
                        || sample.usableBytes < 0n || sample.freeBytes < sample.usableBytes) throw new ArchiveStorageError({ code: 'unmeasurable', location: claim.location });
                    samples.set(claim.path, sample);
                }
                const expected = claim.expectedIdentity ?? this.identities.get(claim.path);
                if (expected && expected !== sample.identity) throw new ArchiveStorageError({ code: 'destination-changed', location: claim.location });
                this.identities.set(claim.path, sample.identity);
                const volume = volumes.get(sample.volume) ?? { bytes: 0n, sample, locations: new Set<string>() };
                volume.bytes += claim.bytes;
                volume.locations.add(claim.location);
                if (sample.usableBytes < volume.sample.usableBytes) volume.sample = sample;
                volumes.set(sample.volume, volume);
            }
            for (const volume of volumes.values()) {
                const required = volume.bytes + this.Policy.reserveBytes + this.Policy.metadataHeadroomBytes;
                if (volume.sample.usableBytes < required) throw new ArchiveStorageError({ code: 'low-space', location: volume.locations.size === 1 ? [...volume.locations][0] : 'shared-volume',
                    usableBytes: String(volume.sample.usableBytes), requiredBytes: String(required), reserveBytes: String(this.Policy.reserveBytes) });
            }
            this.owners.set(owner, candidate);
        });
        this.serial = operation.catch(() => {});
        return operation;
    }

    public async Release(owner: string): Promise<void> {
        const operation = this.serial.then(() => { this.owners.delete(owner); });
        this.serial = operation.catch(() => {});
        await operation;
    }

    public async Check(claims: ArchiveStorageClaim[]): Promise<void> {
        const owner = `check:${randomUUID()}`;
        try { await this.Reserve(owner, claims); } finally { await this.Release(owner); }
    }
}
