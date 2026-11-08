import type { StoreableMediaContainer, MediaItem } from './providers/MediaPlugin';
import { Priority } from './taskpool/DeferredTask';
import type { StorageController } from './StorageController';
import { type IObservable, Observable, ObservableArray } from './Observable';
import type { DownloadOptions, DownloadHandle, DownloadResult, DownloadError, DownloadStage, ExportContext, WrittenFile, ExportProgress, CleanupRetryResult } from './DownloadContract';
import { ImageValidationError, IsValidatedImage } from './ValidateImage';
import { ArchivePersistenceError, ArchiveCapacityError } from './DownloadContract';

export const enum Status {
    Paused = 'paused',
    Queued = 'queued',
    Downloading = 'downloading',
    Processing = 'processing',
    Completed = 'completed',
    Failed = 'failed',
}

export class DownloadTask {
    private timings: Record<string, number> = {};
    private async Bounded<T>(action: (signal: AbortSignal) => Promise<T>, milliseconds: number | undefined, label: string): Promise<T> {
        const start = performance.now(), owned = new AbortController();
        const signal = AbortSignal.any([this.cancellation.signal, owned.signal]);
        let timer: ReturnType<typeof setTimeout>;
        if (milliseconds) timer = setTimeout(() => owned.abort(new DOMException(`${label} timed out`, 'TimeoutError')), milliseconds);
        try {
            if (!milliseconds) return await action(signal);
            return await new Promise<T>((resolve, reject) => {
                const abort = () => { cleanup(); reject(signal.reason); }, cleanup = () => signal.removeEventListener('abort', abort);
                signal.addEventListener('abort', abort, { once: true });
                Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
                if (signal.aborted) abort();
            });
        } finally { clearTimeout(timer); this.timings[label] = (this.timings[label] ?? 0) + Math.round(performance.now() - start); }
    }
    private WaitForArchivePage(milliseconds: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        });
    }

    public readonly ID = Symbol();
    public readonly Created = new Date();

    public readonly TaskID = crypto.randomUUID();
    public readonly Options: Readonly<DownloadOptions>;
    private attemptId = crypto.randomUUID();
    private cancellation = new AbortController();
    private started = false;
    private settled = false;
    private resolveCompletion: (result: DownloadResult) => void;
    private completion = new Promise<DownloadResult>(resolve => { this.resolveCompletion = resolve; });
    private handle: DownloadHandle;
    private DetachSignal: () => void = () => {};
    private stageErrors: DownloadError[] = [];
    private fetchState: DownloadResult['fetch']['state'] = 'not-started';
    private expectedPages: number = null;
    private receivedPages = 0;
    private validatedPages = 0;
    private validationFailed = false;
    private expectedFiles: number = null;
    private attemptedPaths: string[] = [];
    private files: WrittenFile[] = [];
    private outputTarget: { directory?: FileSystemDirectoryHandle; rootId?: string; format?: string } = {};
    private exportProgress = new Observable<ExportProgress, DownloadTask>({ state: 'not-started', expectedFiles: null, writtenFiles: 0 }, this);
    private liveErrors = new Observable<readonly DownloadError[], DownloadTask>([], this);
    private exportInvoked = false;
    private exportSucceeded = false;
    private verification: DownloadResult['verification']['state'] = 'not-performed';
    private verificationStarted = false;
    private verificationMethod: 'file-size' | 'sha256' = 'file-size';
    private cleanupState: DownloadResult['cleanup']['state'] = 'not-needed';
    private remainingKeys: string[] = [];
    private DetachObservables: () => void = () => {};

    constructor(public readonly Media: StoreableMediaContainer<MediaItem>, private readonly storageController: StorageController, options: DownloadOptions = {}) {
        this.Options = Object.freeze({ ...options });
        this.CreateHandle();
    }

    public get Handle(): DownloadHandle { return this.handle; }
    public get IsFinished(): boolean { return this.settled; }

    public FailUnexpected(error: unknown): void {
        if (this.settled) return;
        this.Record('internal', error);
        this.Finish();
    }

    private CreateHandle() {
        const attempt = this.attemptId;
        const status = new Observable<Status, DownloadTask>(Status.Queued, this);
        const progress = new Observable<number, DownloadTask>(0, this);
        const onStatus = (value: Status) => { status.Value = value; };
        const onProgress = (value: number) => { progress.Value = value; };
        this.status.Subscribe(onStatus);
        this.progress.Subscribe(onProgress);
        this.DetachObservables = () => {
            this.status.Unsubscribe(onStatus);
            this.progress.Unsubscribe(onProgress);
        };
        const completion = this.completion;
        let cleanupRetry: Promise<CleanupRetryResult>;
        let cleanupKeys: string[];
        this.handle = Object.freeze({
            taskId: this.TaskID, attemptId: this.attemptId,
            status, progress, completion,
            exportProgress: this.exportProgress, errors: this.liveErrors,
            cancel: (reason?: string) => { if (this.attemptId === attempt) this.Cancel(reason); },
            retryCleanup: () => {
                if (cleanupRetry) return cleanupRetry;
                cleanupRetry = completion.then(async result => {
                    cleanupKeys ??= [...result.cleanup.remainingKeys];
                    let state = result.cleanup.state;
                    const errors: Error[] = [];
                    if (cleanupKeys.length) {
                        try {
                            await this.storageController.RemoveTemporary(...cleanupKeys);
                            cleanupKeys = [];
                            state = 'completed';
                        } catch(error) {
                            state = 'failed';
                            errors.push(error instanceof Error ? error : new Error(String(error)));
                        }
                    } else if (state === 'failed') state = 'completed';
                    return Object.freeze({ attemptId: attempt, state, remainingKeys: Object.freeze([...cleanupKeys]), errors: Object.freeze(errors) });
                }).finally(() => { cleanupRetry = undefined; });
                return cleanupRetry;
            },
        });
        if (this.Options.signal) {
            const signal = this.Options.signal;
            const abort = () => this.Cancel('Download cancelled by caller');
            this.DetachSignal = () => signal.removeEventListener('abort', abort);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        }
    }

    public Cancel(reason = 'Download cancelled'): void {
        if (this.settled) return;
        this.cancellation.abort(new DOMException(reason, 'AbortError'));
        if (!this.started) this.Finish();
    }

    private Record(stage: DownloadStage, error: unknown, page?: number) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.errors.Push(normalized);
        this.stageErrors.push({ stage, error: normalized, page });
        this.liveErrors.Value = Object.freeze([...this.stageErrors]);
    }

    private async VerifyOutput(): Promise<void> {
        if (this.verificationStarted || !this.files.length) return;
        this.verificationStarted = true;
        this.verification = 'passed';
        this.verificationMethod = this.Options.archiveTarget ? 'sha256' : 'file-size';
        for (const file of this.files) {
            try {
                if (this.Options.archiveTarget) {
                    if (file.rootId !== this.Options.archiveTarget.rootId || !file.fileId || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new Error('Native archive receipt is missing its verified fingerprint');
                } else if (!file.handle || (await file.handle.getFile()).size !== file.size) throw new Error(`Exported file size mismatch: ${file.path}`);
            } catch(error) {
                this.verification = 'failed';
                this.Record('verification', error);
            }
        }
    }

    private Finish() {
        if (this.settled) return;
        this.settled = true;
        this.DetachSignal();
        const written = this.expectedFiles !== null && this.files.length === this.expectedFiles;
        const success = this.exportSucceeded && written && this.verification === 'passed'
            && this.stageErrors.every(error => error.stage === 'cleanup');
        const outputState: DownloadResult['output']['state'] = written ? 'written' : this.files.length ? 'partial'
            : this.attemptedPaths.length || this.exportSucceeded ? 'unknown' : this.exportInvoked ? 'failed' : 'not-started';
        const result: DownloadResult = Object.freeze({
            timings: Object.freeze({ ...this.timings }),
            taskId: this.TaskID, attemptId: this.attemptId,
            outcome: success ? this.cleanupState === 'failed' ? 'succeeded-with-warnings' : 'succeeded'
                : this.cancellation.signal.aborted ? 'cancelled' : this.stageErrors.length ? 'failed' : 'unverified',
            cancellationRequested: this.cancellation.signal.aborted,
            cancellationReason: this.cancellation.signal.aborted ? String(this.cancellation.signal.reason?.message ?? this.cancellation.signal.reason) : undefined,
            fetch: Object.freeze({ state: this.fetchState, expectedPages: this.expectedPages, receivedPages: this.receivedPages, sourceCompleteness: 'unknown' }),
            inputValidation: Object.freeze({
                state: this.validationFailed ? 'failed' : this.expectedPages > 0 && this.validatedPages === this.expectedPages ? 'passed' : this.validatedPages ? 'partial' : 'not-performed',
                validatedPages: this.validatedPages, method: 'browser-image-decoder',
            }),
            output: Object.freeze({ state: outputState, ...this.outputTarget, expectedFiles: this.expectedFiles, attemptedPaths: Object.freeze([...this.attemptedPaths]), files: Object.freeze([...this.files]) }),
            verification: Object.freeze({ state: this.verification, method: this.verificationMethod }),
            cleanup: Object.freeze({ state: this.cleanupState, remainingKeys: Object.freeze([...this.remainingKeys]) }),
            errors: Object.freeze(this.stageErrors.map(error => Object.freeze({ ...error }))),
        });
        const resolve = this.resolveCompletion;
        const detach = this.DetachObservables;
        // Finish all mutable attempt bookkeeping before notifying legacy subscribers,
        // which may synchronously start a new attempt from a terminal status callback.
        this.Abort = this.DisabledAbort;
        this.exportProgress.Value = Object.freeze({ state: outputState, expectedFiles: this.expectedFiles, writtenFiles: this.files.length });
        // Keep the legacy UI's conservative failure indication for cleanup errors.
        this.status.Value = this.errors.Value.length || this.cancellation.signal.aborted ? Status.Failed : Status.Completed;
        detach();
        resolve(result);
    }

    private ResetAttempt() {
        this.timings = {};
        this.attemptId = crypto.randomUUID();
        this.cancellation = new AbortController();
        this.started = this.settled = false;
        this.stageErrors = [];
        this.fetchState = 'not-started';
        this.expectedPages = this.expectedFiles = null;
        this.receivedPages = 0;
        this.validatedPages = 0;
        this.validationFailed = false;
        this.attemptedPaths = [];
        this.files = [];
        this.outputTarget = {};
        this.exportProgress = new Observable<ExportProgress, DownloadTask>({ state: 'not-started', expectedFiles: null, writtenFiles: 0 }, this);
        this.liveErrors = new Observable<readonly DownloadError[], DownloadTask>([], this);
        this.errors.Value = [];
        this.exportInvoked = this.exportSucceeded = false;
        this.verification = 'not-performed';
        this.verificationStarted = false;
        this.verificationMethod = 'file-size';
        this.cleanupState = 'not-needed';
        this.remainingKeys = [];
        this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
        this.CreateHandle();
    }

    private errors = new ObservableArray<Error, typeof this>([], this);
    public get Errors(): IObservable<Error[], typeof this> {
        return this.errors;
    }

    private readonly status = new Observable(Status.Queued, this);
    public get Status(): IObservable<Status, typeof this> {
        return this.status;
    }

    private progress = new Observable(0.0, this);
    public get Progress(): IObservable<number, typeof this> {
        return this.progress;
    }

    private UpdateProgress(processed: number) {
        this.progress.Value = this.Media.Entries.Value.length > 0 ? processed / this.Media.Entries.Value.length : 0.0;
    }

    private get IsRunning(): boolean {
        return this.status.Value === Status.Downloading || this.status.Value === Status.Processing;
    }

    /**
     * Assert that the {@link Media} entries for this download task are valid
     * @throws {@link RangeError} if the media entries are empty
     */
    private AssertMediaEntries() {
        new Array(this.Media.Entries.Value.length - 1);
    }

    public async Run(/* Target Directory / Archive ? */): Promise<void> {

        if(this.IsRunning) {
            return;
        }
        if (this.settled && !this.started) return;
        if (this.settled) this.ResetAttempt();
        if (this.settled) return; // An already-aborted external signal settled the new attempt.
        this.started = true;
        this.errors.Value = [];
        this.status.Value = Status.Downloading;

        const resourcemap = new Map<number, string>();
        let stage: DownloadStage = 'prepare';
        try {
            this.UpdateProgress(0);
            const cancellator = this.cancellation;
            this.Abort = () => this.Cancel();
            cancellator.signal.throwIfAborted();
            stage = 'repository';
            if (this.Options.archiveTarget) await this.Options.archiveTarget.checkpoint('prepare', 0, 0);
            stage = 'prepare';
            if (this.Options.archiveTarget) await this.Bounded(() => this.Media.Update(), 90000, 'prepare');
            else await this.Media.Update();
            cancellator.signal.throwIfAborted();
            stage = 'fetch';
            this.fetchState = 'running';
            this.AssertMediaEntries();
            this.expectedPages = this.Media.Entries.Value.length;
            stage = 'repository';
            if (this.Options.archiveTarget) await this.Options.archiveTarget.checkpoint('fetch', 0, 0);
            stage = 'fetch';
            if (this.Options.pageDelayMs !== undefined && (!this.Options.archiveTarget || !Number.isFinite(this.Options.pageDelayMs) || this.Options.pageDelayMs < 100 || this.Options.pageDelayMs > 60_000)) throw new Error('Invalid archive page delay');
            const fetch = async (item: MediaItem, index: number) => {
                let itemStage: DownloadStage = 'fetch';
                try {
                    cancellator.signal.throwIfAborted();
                    if (this.Options.archiveTarget?.beforeFetch) await this.Options.archiveTarget.beforeFetch();
                    const data = await this.Bounded(signal => item.Fetch(Priority.Low, signal), this.Options.archiveTarget ? this.Options.pageTimeoutMs ?? 60000 : undefined, 'fetch-and-validation');
                    cancellator.signal.throwIfAborted();
                    this.receivedPages++;
                    if (IsValidatedImage(data)) this.validatedPages++;
                    itemStage = 'temporary-storage';
                    if (this.Options.archiveTarget?.beforeTemporaryWrite) await this.Options.archiveTarget.beforeTemporaryWrite(data.size);
                    if (this.Options.beforeTemporaryWrite) await this.Options.beforeTemporaryWrite(data.size);
                    cancellator.signal.throwIfAborted();
                    const resource = await this.Bounded(() => this.storageController.SaveTemporary(data), undefined, 'temporary-storage');
                    resourcemap.set(index, resource);
                    this.UpdateProgress(resourcemap.size);
                    itemStage = 'repository';
                    if (this.Options.archiveTarget) await this.Options.archiveTarget.checkpoint('fetch', this.receivedPages, this.validatedPages);
                } catch(error) {
                    if (this.Options.archiveTarget && error instanceof DOMException && error.name === 'QuotaExceededError') error = new ArchiveCapacityError('Browser temporary storage quota was exhausted during writing', { code: 'quota-exceeded', location: 'indexeddb' });
                    if (error instanceof ImageValidationError) this.validationFailed = true;
                    this.Record(error instanceof ImageValidationError ? 'validation' : error instanceof ArchivePersistenceError ? 'repository' : itemStage, error, index + 1);
                    // TODO: Abort all other pending downloads or keep running?
                    throw error;
                }
            };
            if (this.Options.pageDelayMs === undefined && !this.Options.archiveTarget) {
                await Promise.allSettled(this.Media.Entries.Value.map(fetch));
            } else {
                // Do not enqueue every page in a second task pool: its throttle timer is not abortable.
                for (let index = 0; index < this.Media.Entries.Value.length; index++) {
                    cancellator.signal.throwIfAborted();
                    if (index && this.Options.pageDelayMs) await this.Bounded(() => this.WaitForArchivePage(this.Options.pageDelayMs, cancellator.signal), undefined, 'intentional-delay');
                    try { await fetch(this.Media.Entries.Value[index], index); }
                    catch { break; /* Required page failed: do not hammer every remaining page of an incomplete chapter. */ }
                }
            }
            this.fetchState = cancellator.signal.aborted ? 'cancelled'
                : this.stageErrors.some(error => error.stage === 'fetch' || error.stage === 'validation') ? 'failed' : 'succeeded';
            cancellator.signal.throwIfAborted();
            if(this.errors.Value.length === 0) {
                this.UpdateProgress(-1 * this.Media.Entries.Value.length);
                this.status.Value = Status.Processing;
                stage = 'export';
                this.exportInvoked = true;
                this.exportProgress.Value = Object.freeze({ state: 'preparing', expectedFiles: null, writtenFiles: 0 });
                const context: ExportContext = {
                    signal: cancellator.signal,
                    existingFiles: this.Options.existingFiles ?? ((this.Options.owner ?? 'manual') === 'manual' ? 'replace' : 'preserve'),
                    begin: async (count, target) => {
                        this.expectedFiles = count;
                        this.outputTarget = { ...target };
                        this.exportProgress.Value = Object.freeze({ state: 'preparing', expectedFiles: count, writtenFiles: this.files.length });
                        if (this.Options.archiveTarget) await this.Options.archiveTarget.beginExport(count, target?.format ?? this.Options.archiveTarget.format);
                        if (this.Options.archiveTarget?.prepare) await this.Options.archiveTarget.prepare((this.expectedPages ?? 0) * 64 * 1024);
                    },
                    prepare: this.Options.archiveTarget?.prepare,
                    writing: path => {
                        this.attemptedPaths.push(path);
                        this.exportProgress.Value = Object.freeze({ state: 'writing', expectedFiles: this.expectedFiles, writtenFiles: this.files.length });
                    },
                    written: file => {
                        this.files.push(Object.freeze({ ...file }));
                        this.exportProgress.Value = Object.freeze({ state: this.files.length === this.expectedFiles ? 'written' : 'writing', expectedFiles: this.expectedFiles, writtenFiles: this.files.length });
                    },
                    verify: () => this.VerifyOutput(),
                };
                await this.Bounded(() => this.Media.Store(resourcemap, { ...this.Options, context }), undefined, 'export');
                this.exportSucceeded = true;
            }
        } catch(error) {
            if (this.fetchState === 'running') this.fetchState = this.cancellation.signal.aborted ? 'cancelled' : 'failed';
            this.Record(error instanceof ArchivePersistenceError ? 'repository' : stage, error);
        } finally {
            await this.VerifyOutput();
            try {
                // An empty key list clears the whole temporary store, including other tasks.
                if(resourcemap.size > 0) {
                    this.remainingKeys = [...resourcemap.values()];
                    await this.storageController.RemoveTemporary(...this.remainingKeys);
                    this.remainingKeys = [];
                    this.cleanupState = 'completed';
                }
            } catch(error) {
                this.cleanupState = 'failed';
                this.Record('cleanup', error);
            }
            try {
                this.UpdateProgress(resourcemap.size);
            } catch(error) {
                this.Record('internal', error);
            } finally {
                this.Finish();
            }
        }
    }

    private DisabledAbort(/*_reason?: string*/) { /* NO-OP */ }

    public Abort = this.DisabledAbort;
}
