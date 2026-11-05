import type { IObservable } from './Observable';
import type { Status, DownloadTask } from './DownloadTask';

export interface DownloadOptions {
    readonly directory?: FileSystemDirectoryHandle;
    readonly format?: string;
    readonly useWebsiteSubDirectory?: boolean;
    /** Independent callers must not share cancellation ownership. Defaults to manual. */
    readonly owner?: string;
    readonly signal?: AbortSignal;
}

export type DownloadStage = 'prepare' | 'fetch' | 'validation' | 'temporary-storage' | 'export' | 'verification' | 'cleanup' | 'internal';

export interface DownloadError {
    readonly stage: DownloadStage;
    readonly error: Error;
}

export interface WrittenFile {
    readonly path: string;
    readonly size: number;
    readonly handle: FileSystemFileHandle;
}

export interface ExportContext {
    readonly signal: AbortSignal;
    begin(expectedFiles: number, target?: { directory: FileSystemDirectoryHandle; format: string }): void;
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
    };
    readonly verification: {
        readonly state: 'not-performed' | 'passed' | 'failed';
        readonly method: 'file-size';
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
