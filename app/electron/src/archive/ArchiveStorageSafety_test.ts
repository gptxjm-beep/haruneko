import { describe, expect, it, vi } from 'vitest';
import { ArchiveStorageSafety, DefaultArchiveStoragePolicy } from './ArchiveStorageSafety';
import { StorageFailure } from './ArchiveStorageContract';

describe('Archive storage reservations', () => {
    it('Should use a 50 GiB reserve by default', () => {
        expect(DefaultArchiveStoragePolicy.reserveBytes).toBe(50n * 1024n ** 3n);
    });

    it('Should budget large files with exact bigint arithmetic without allocating their contents', async () => {
        const safety = new ArchiveStorageSafety(undefined, async () => ({ volume: 'disk', identity: 'directory', freeBytes: 128n * 1024n ** 3n, usableBytes: 128n * 1024n ** 3n }));
        await safety.Reserve('large', [{ slot: 'output', location: 'archive', path: '/a', bytes: 16n * 1024n ** 3n }, { slot: 'stage', location: 'staging', path: '/b', bytes: 16n * 1024n ** 3n }]);
    });

    it('Should enforce usable space rather than privileged filesystem free space', async () => {
        const safety = new ArchiveStorageSafety({ reserveBytes: 50n, metadataHeadroomBytes: 0n }, async () => ({ volume: 'disk', identity: 'directory', freeBytes: 1000n, usableBytes: 49n }));
        await expect(safety.Check([{ slot: 'output', location: 'archive', path: '/a', bytes: 0n }])).rejects.toMatchObject({ Fault: { code: 'low-space', usableBytes: '49' } });
    });

    it('Should fail closed when capacity is unavailable', async () => {
        const safety = new ArchiveStorageSafety(undefined, async () => { throw new Error('Unsupported statfs'); });
        await expect(safety.Check([{ slot: 'output', location: 'archive', path: '/a', bytes: 0n }])).rejects.toMatchObject({ Fault: { code: 'unmeasurable' } });
    });

    it('Should bound a filesystem probe that never returns', async () => {
        vi.useFakeTimers();
        try {
            const safety = new ArchiveStorageSafety(undefined, async () => new Promise(() => {}));
            const checked = expect(safety.Check([{ slot: 'output', location: 'archive', path: '/a', bytes: 0n }])).rejects.toMatchObject({ Fault: { code: 'unmeasurable', systemCode: 'MEASUREMENT_TIMEOUT' } });
            await vi.advanceTimersByTimeAsync(5000);
            await checked;
        } finally { vi.useRealTimers(); }
    });

    it.each([['ENOENT', 'disconnected'], ['ENODEV', 'disconnected'], ['EACCES', 'permission-denied'], ['EROFS', 'permission-denied']])('Should distinguish %s', async (code, expected) => {
        const safety = new ArchiveStorageSafety(undefined, async () => { throw Object.assign(new Error(code), { code }); });
        await expect(safety.Check([{ slot: 'output', location: 'archive', path: '/a', bytes: 0n }])).rejects.toMatchObject({ Fault: { code: expected } });
    });

    it('Should reject a changed directory identity', async () => {
        let identity = 'original';
        const safety = new ArchiveStorageSafety({ reserveBytes: 0n, metadataHeadroomBytes: 0n }, async () => ({ volume: 'disk', identity, freeBytes: 100n, usableBytes: 100n }));
        const claims = [{ slot: 'output', location: 'archive', path: '/a', bytes: 1n }];
        await safety.Reserve('owner', claims);
        identity = 'replacement';
        await expect(safety.Reserve('owner', claims)).rejects.toMatchObject({ Fault: { code: 'destination-changed' } });
    });

    it('Should remeasure external writes and reject actual growth without discarding the earlier claim', async () => {
        let usable = 100n;
        const safety = new ArchiveStorageSafety({ reserveBytes: 50n, metadataHeadroomBytes: 0n }, async () => ({ volume: 'disk', identity: 'directory', freeBytes: usable, usableBytes: usable }));
        await safety.Reserve('a', [{ slot: 'output', location: 'archive', path: '/a', bytes: 30n }]);
        usable = 70n;
        await expect(safety.Reserve('a', [{ slot: 'output', location: 'archive', path: '/a', bytes: 30n }])).rejects.toMatchObject({ Fault: { code: 'low-space' } });
        usable = 100n;
        await expect(safety.Reserve('a', [{ slot: 'output', location: 'archive', path: '/a', bytes: 60n }])).rejects.toMatchObject({ Fault: { code: 'low-space' } });
        await expect(safety.Reserve('b', [{ slot: 'output', location: 'archive', path: '/b', bytes: 30n }])).rejects.toMatchObject({ Fault: { code: 'low-space' } });
        await safety.Release('a');
        await safety.Reserve('b', [{ slot: 'output', location: 'archive', path: '/b', bytes: 30n }]);
    });

    it('Should add simultaneous final and staging allocations when paths share a volume', async () => {
        const safety = new ArchiveStorageSafety({ reserveBytes: 50n, metadataHeadroomBytes: 0n }, async () => ({ volume: 'disk', identity: 'directory', freeBytes: 100n, usableBytes: 100n }));
        await expect(safety.Reserve('a', [{ slot: 'final', location: 'archive', path: '/out', bytes: 30n }, { slot: 'stage', location: 'staging', path: '/stage', bytes: 30n }])).rejects.toMatchObject({ Fault: { code: 'low-space' } });
    });

    it('Should classify actual filesystem and SQLite full errors separately', () => {
        expect(StorageFailure(Object.assign(new Error('write failed'), { code: 'ENOSPC' }), 'archive')?.Fault.code).toBe('write-full');
        expect(StorageFailure(new Error('database or disk is full'), 'database')?.Fault.code).toBe('write-full');
    });
    it('Should serialize competing claims on the same physical volume', async () => {
        const safety = new ArchiveStorageSafety({ reserveBytes: 50n, metadataHeadroomBytes: 10n }, async () => ({ volume: 'disk', identity: 'directory', freeBytes: 100n, usableBytes: 100n }));
        const outcomes = await Promise.allSettled([
            safety.Reserve('a', [{ slot: 'output', location: 'archive', path: '/a', bytes: 30n }]),
            safety.Reserve('b', [{ slot: 'output', location: 'archive', path: '/b', bytes: 30n }]),
        ]);
        expect(outcomes.filter(result => result.status === 'fulfilled').length).toBe(1);
    });

    it('Should check the staging volume independently of the archive volume', async () => {
        const safety = new ArchiveStorageSafety({ reserveBytes: 50n, metadataHeadroomBytes: 0n }, async path => ({ volume: path, identity: path, freeBytes: path === '/stage' ? 55n : 1000n, usableBytes: path === '/stage' ? 55n : 1000n }));
        await expect(safety.Reserve('a', [{ slot: 'final', location: 'archive', path: '/out', bytes: 10n }, { slot: 'stage', location: 'staging', path: '/stage', bytes: 10n }])).rejects.toMatchObject({ Fault: { code: 'low-space', location: 'staging' } });
    });
});
