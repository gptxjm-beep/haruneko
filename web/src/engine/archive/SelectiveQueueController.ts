import { Observable } from '../Observable';
import { ArchiveClient } from './ArchiveClient';
import { ArchiveUIError } from './ArchiveUIController';
import type { MangaReference, QueueManga, QueueSnapshot, SelectedManga, QueueScope, QueueMembership } from '../../../../app/electron/src/archive/SelectiveQueueContract';
export const QueueIdentity = (ref: Pick<MangaReference, 'siteId' | 'mangaId'>) => JSON.stringify([ref.siteId, ref.mangaId]);
const Reference = (ref: MangaReference): MangaReference => ({ siteId: ref.siteId, mangaId: ref.mangaId, title: ref.title, siteName: ref.siteName });
export class SelectiveQueueController {
    public readonly State = new Observable<{ summary: QueueSnapshot | null; flags: Record<string, boolean>; queued: Record<string, boolean>; message: string; error: string }>({ summary: null, flags: {}, queued: {}, message: '', error: '' });
    private flagSerial = 0;
    constructor(public readonly Client = new ArchiveClient()) {}
    public async Refresh(): Promise<void> { this.State.Value = { ...this.State.Value, summary: await this.Client.Request<QueueSnapshot>({ operation: 'queue-summary' }) }; }
    public async Flags(references: MangaReference[]): Promise<void> {
        const serial = ++this.flagSerial;
        const flags = await this.Client.Request<QueueMembership[]>({ operation: 'queue-selected', references });
        if (serial === this.flagSerial) this.State.Value = { ...this.State.Value, flags: Object.fromEntries(references.map((ref, n) => [QueueIdentity(ref), flags[n].selected])), queued: Object.fromEntries(references.map((ref, n) => [QueueIdentity(ref), flags[n].queued])) };
    }
    public async Select(reference: MangaReference, selected: boolean): Promise<void> {
        await this.Client.Request({ operation: 'queue-select', reference: Reference(reference), selected });
        this.flagSerial++; this.State.Value = { ...this.State.Value, flags: { ...this.State.Value.flags, [QueueIdentity(reference)]: selected } }; await this.Refresh();
    }
    public async Add(reference?: MangaReference): Promise<void> {
        const result = await this.Client.Request<{ added: number; existing: number }>({ operation: 'queue-add', reference: reference ? Reference(reference) : undefined });
        await this.Refresh();
        const queued = { ...this.State.Value.queued };
        if (reference) queued[QueueIdentity(reference)] = true;
        else for (const [id, selected] of Object.entries(this.State.Value.flags)) if (selected) queued[id] = true;
        this.State.Value = { ...this.State.Value, queued, message: `Added ${result.added}; already present ${result.existing}. Downloads have not started.` };
    }
    public async Selections(after?: number): Promise<SelectedManga[]> { return this.Client.Request({ operation: 'queue-selections', after }); }
    public async List(offset?: number): Promise<QueueManga[]> { return this.Client.Request({ operation: 'queue-list', offset }); }
    public async Edit(seq: number, action: 'remove' | 'up' | 'down', scope?: QueueScope): Promise<void> { await this.Client.Request({ operation: 'queue-edit', seq, action, scope }); await this.Refresh(); }
    public async Supplement(seq: number, scope: QueueScope): Promise<void> { await this.Client.Request({ operation: 'queue-supplement', seq, scope, confirmed: true }); await this.Refresh(); }
    public async Audit(seq: number): Promise<{ id: string; localState: string }[]> { return this.Client.Request({ operation: 'queue-audit', seq }); }
    public Error(error: unknown): void { this.State.Value = { ...this.State.Value, error: ArchiveUIError(error) }; }
    public ClearError(): void { if (this.State.Value.error) this.State.Value = { ...this.State.Value, error: '' }; }
}
let queue: SelectiveQueueController;
export const QueueSupported = () => !!globalThis.ipcRenderer?.invoke;
export function GetSelectiveQueueController(): SelectiveQueueController { return queue ??= new SelectiveQueueController(); }
