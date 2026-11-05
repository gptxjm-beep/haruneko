import { DownloadTask, Status } from './DownloadTask';
import { ObservableArray, type IObservable } from './Observable';
import type { StoreableMediaContainer, MediaItem } from './providers/MediaPlugin';
import type { StorageController } from './StorageController';
import { Delay } from './BackgroundTimers';
import type { DownloadHandle, DownloadOptions } from './DownloadContract';

export class DownloadManager {

    private processing = false;
    private queue = new ObservableArray<DownloadTask, DownloadManager>([], this);
    private queueTransactionLock = false;

    constructor(private readonly storageController: StorageController) {}

    public get Queue(): IObservable<DownloadTask[], DownloadManager> {
        return this.queue;
    }

    /**
     * Perform an (almost) thread/concurrency safe operation on {@link queue}
     */
    private async InvokeQueueTransaction<R>(transaction: () => R | Promise<R>): Promise<R> {
        try {
            while(this.queueTransactionLock) await Delay(5);
            this.queueTransactionLock = true;
            return await transaction();
        } finally {
            this.queueTransactionLock = false;
        }
    }

    /**
     * Add the given {@link containers} to the download queue.
     * Only containers that are not present in the download queue will be added.
     */
    public async Enqueue(...containers: StoreableMediaContainer<MediaItem>[]): Promise<void> {
        await this.InvokeQueueTransaction(async () => {
            const tasks: DownloadTask[] = [];
            for (const container of containers.distinct()) {
                // Preserve legacy deduplication, including terminal manual tasks. Explicit
                // retries use EnqueueTask, which only deduplicates active attempts.
                const existing = this.queue.Value.some(task => task.Media.IsSameAs(container)
                    && (task.Options.owner ?? 'manual') === 'manual' && !task.Options.directory
                    && task.Options.format === undefined && task.Options.useWebsiteSubDirectory === undefined);
                if (!existing) tasks.push(new DownloadTask(container, this.storageController));
            }
            this.queue.Push(...tasks);
        });
        this.Process();
    }

    /** Enqueue an owned attempt; terminal attempts never block an explicit new request. */
    public async EnqueueTask(container: StoreableMediaContainer<MediaItem>, options: DownloadOptions = {}): Promise<DownloadHandle> {
        const snapshot = Object.freeze({ ...options });
        const handle = await this.InvokeQueueTransaction(async () => {
            const active = await this.FindActive(container, snapshot);
            if (active) return active.Handle;
            const task = new DownloadTask(container, this.storageController, snapshot);
            this.queue.Push(task);
            if ((snapshot.retention ?? ((snapshot.owner ?? 'manual') === 'manual' ? 'keep' : 'release')) === 'release') {
                task.Handle.completion.then(() => this.InvokeQueueTransaction(() => {
                    this.queue.Value = this.queue.Value.filter(entry => entry !== task);
                }));
            }
            return task.Handle;
        });
        this.Process();
        return handle;
    }

    private async FindActive(container: StoreableMediaContainer<MediaItem>, options: DownloadOptions): Promise<DownloadTask> {
        for (const task of this.queue.Value) {
            const previous = task.Options;
            if (task.IsFinished || !task.Media.IsSameAs(container)
                || (previous.owner ?? 'manual') !== (options.owner ?? 'manual')
                || previous.signal !== options.signal || previous.format !== options.format
                || previous.existingFiles !== options.existingFiles
                || previous.useWebsiteSubDirectory !== options.useWebsiteSubDirectory) continue;
            if (previous.directory === options.directory
                || previous.directory && options.directory && await previous.directory.isSameEntry(options.directory)) return task;
        }
    }

    /**
     * Remove the given {@link tasks} from the download queue.
     * Only tasks that are present in the download queue will be removed.
     */
    public async Dequeue(...tasks: DownloadTask[]): Promise<void> {
        await this.InvokeQueueTransaction(() => {
            this.queue.Value = this.queue.Value.filter(task => {
                if(tasks.includes(task)) {
                    task.Cancel();
                    return false;
                } else {
                    return true;
                }
            });
        });
    }

    private async Process() {
        if(this.processing) {
            return;
        }
        this.processing = true;

        try {
            while(true) {
                let task: DownloadTask;
                try {
                    task = await this.InvokeQueueTransaction(() => this.queue.Value.find(task => task.Status.Value === Status.Queued));
                    if (!task) break;
                    await task.Run();
                } catch(error) {
                    task?.FailUnexpected(error);
                }
            }
        } finally {
            this.processing = false;
            // An enqueue may have arrived between the final lookup and this continuation.
            if (this.queue.Value.some(task => task.Status.Value === Status.Queued)) this.Process();
        }
    }
}
