export type ArchiveStorageCode = 'low-space' | 'unmeasurable' | 'disconnected' | 'destination-changed' | 'permission-denied' | 'write-full' | 'quota-exceeded';
export interface ArchiveStorageFault {
    code: ArchiveStorageCode;
    location: string;
    usableBytes?: string;
    requiredBytes?: string;
    reserveBytes?: string;
    systemCode?: string;
}
export class ArchiveStorageError extends Error {
    constructor(public readonly Fault: ArchiveStorageFault) { super(`Archive storage ${Fault.code} (${Fault.location})`); }
}

export function StorageFailure(error: unknown, location: string): ArchiveStorageError | undefined {
    if (error instanceof ArchiveStorageError) return error;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const message = error instanceof Error ? error.message : '';
    if (['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(code) || /SQLITE_FULL|database or disk is full/i.test(message)) return new ArchiveStorageError({ code: 'write-full', location, systemCode: code });
    if (['ENOENT', 'ENODEV', 'ENXIO', 'EIO', 'ESTALE'].includes(code)) return new ArchiveStorageError({ code: 'disconnected', location, systemCode: code });
    if (['EACCES', 'EPERM', 'EROFS'].includes(code)) return new ArchiveStorageError({ code: 'permission-denied', location, systemCode: code });
    return undefined;
}
