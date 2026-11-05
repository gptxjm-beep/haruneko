import type { IObservable } from './Observable';
import type { Status, DownloadTask } from './DownloadTask';

export interface DownloadOptions {
    readonly directory?: FileSystemDirectoryHandle;
    readonly format?: string;
    readonly useWebsiteSubDirectory?: boolean;
    /** Independent callers must not share cancellation ownership. Defaults to manual. */
    readonly owner?: string;
    readonly signal?: AbortSignal;
    /** Manual history is retained; owned automation is released by default. */
    readonly retention?: 'keep' | 'release';
    readonly existingFiles?: 'replace' | 'preserve';
    readonly archiveTarget?: NativeArchiveTarget;
    /** Bounded archive page fetching; absent for existing manual callers. */
    readonly pageDelayMs?: number;
    readonly beforeTemporaryWrite?: (bytes: number) => Promise<void>;
}

export class ArchivePersistenceError extends Error {}
/** A future capacity gate can stop the coordinator rather than treating low space as a bad chapter. */
export class ArchiveCapacityError extends Error {}

export interface NativeArchiveTarget {
    readonly identity: string;
    readonly rootId: string;
    readonly format: string;
    readonly useWebsiteSubDirectory: boolean;
    checkpoint(stage: DownloadStage, receivedPages: number, validatedPages: number): Promise<void>;
    beginExport(expectedFiles: number, format: string): Promise<void>;
    write(path: string, data: Blob, signal: AbortSignal): Promise<WrittenFile>;
}

export type DownloadStage = 'prepare' | 'fetch' | 'validation' | 'temporary-storage' | 'export' | 'verification' | 'cleanup' | 'internal' | 'repository';

export interface DownloadError {
    readonly stage: DownloadStage;
    readonly error: Error;
}

export interface WrittenFile {
    readonly path: string;
    readonly size: number;
    readonly handle?: FileSystemFileHandle;
    readonly fileId?: string;
    readonly rootId?: string;
    readonly sha256?: string;
}

export interface ExportContext {
    readonly signal: AbortSignal;
    readonly existingFiles?: 'replace' | 'preserve';
    begin(expectedFiles: number, target?: { directory?: FileSystemDirectoryHandle; rootId?: string; format: string }): void | Promise<void>;
    write?(path: string, data: Blob, signal: AbortSignal): Promise<WrittenFile>;
    writing(path: string): void;
    written(file: WrittenFile): void;
    /** Verify acknowledged files before the output directory lock is released. */
    verify?(): Promise<void>;
}

export interface StoreOptions extends DownloadOptions {
    readonly context?: ExportContext;
}

export interface DownloadResult {
    readonly taskId: string;
    readonly attemptId: string;
    readonly outcome: 'succeeded' | 'succeeded-with-warnings' | 'failed' | 'cancelled' | 'unverified';
    readonly cancellationRequested: boolean;
    readonly cancellationReason?: string;
    readonly fetch: {
        readonly state: 'not-started' | 'running' | 'succeeded' | 'failed' | 'cancelled';
        readonly expectedPages: number | null;
        readonly receivedPages: number;
        /** Lists returned by a connector do not prove source completeness. */
        readonly sourceCompleteness: 'unknown';
    };
    readonly inputValidation: {
        readonly state: 'not-performed' | 'partial' | 'passed' | 'failed';
        readonly validatedPages: number;
        readonly method: 'browser-image-decoder';
    };
    readonly output: {
        readonly state: 'not-started' | 'writing' | 'written' | 'partial' | 'failed' | 'unknown';
        readonly expectedFiles: number | null;
        readonly attemptedPaths: readonly string[];
        readonly files: readonly WrittenFile[];
        readonly directory?: FileSystemDirectoryHandle;
        readonly format?: string;
        readonly rootId?: string;
    };
    readonly verification: {
        readonly state: 'not-performed' | 'passed' | 'failed';
        readonly method: 'file-size' | 'sha256';
    };
    readonly cleanup: {
        readonly state: 'not-needed' | 'completed' | 'failed';
        readonly remainingKeys: readonly string[];
    };
    readonly errors: readonly DownloadError[];
}

export interface CleanupRetryResult {
    readonly attemptId: string;
    readonly state: 'not-needed' | 'completed' | 'failed';
    readonly remainingKeys: readonly string[];
    readonly errors: readonly Error[];
}

export interface ExportProgress {
    readonly state: DownloadResult['output']['state'] | 'preparing';
    readonly expectedFiles: number | null;
    readonly writtenFiles: number;
}

export interface DownloadHandle {
    readonly taskId: string;
    readonly attemptId: string;
    readonly status: IObservable<Status, DownloadTask>;
    readonly progress: IObservable<number, DownloadTask>;
    readonly exportProgress: IObservable<ExportProgress, DownloadTask>;
    readonly errors: IObservable<readonly DownloadError[], DownloadTask>;
    readonly completion: Promise<DownloadResult>;
    cancel(reason?: string): void;
    /** Retry only this attempt's remaining temporary keys; never fetch or export again. */
    retryCleanup(): Promise<CleanupRetryResult>;
}
