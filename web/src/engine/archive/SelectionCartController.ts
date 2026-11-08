import { ArchiveClient } from './ArchiveClient';
import { Observable } from '../Observable';
import { GetSelectiveQueueController, QueueIdentity } from './SelectiveQueueController';
import type { MangaReference } from '../../../../app/electron/src/archive/SelectiveQueueContract';
import type { CartSelection } from '../../../../app/electron/src/archive/SelectionCartContract';
export class SelectionCartController {
    public readonly State = new Observable<{ items: CartSelection[]; error: string; message: string }>({ items: [], error: '', message: '' });
    private serial = 0;
    constructor(public readonly Client = new ArchiveClient()) {}
    public async Refresh(): Promise<void> {
        const serial = ++this.serial, items: CartSelection[] = [];
        for (let after = 0; ; ) { const page = await this.Client.Request<CartSelection[]>({ operation: 'cart-list', after }); items.push(...page); if (page.length < 100) break; after = page.at(-1).seq; }
        if (serial === this.serial) this.State.Value = { ...this.State.Value, items };
        await GetSelectiveQueueController().Refresh();
    }
    public Find(ref: MangaReference): CartSelection | undefined { return this.State.Value.items.find(item => QueueIdentity(item) === QueueIdentity(ref)); }
    public async Save(reference: MangaReference, selection: Pick<CartSelection, 'mode' | 'ids' | 'order' | 'direction' | 'chapters'>): Promise<void> {
        try { await this.Client.Request({ operation: 'cart-save', reference, selection, expectedRevision: this.Find(reference)?.revision ?? 0 }); } catch(error) { await this.Refresh().catch(() => {}); throw error; } await this.Refresh();
    }
    public async Select(reference: MangaReference, selected: boolean, _confirmed = false): Promise<void> {
        const previous = this.Find(reference);
        if (selected) { if (!previous) await this.Save(reference, { mode: 'all', ids: [], order: 'source' }); }
        else if (previous) { await this.Client.Request({ operation: 'cart-remove', seq: previous.seq, expectedRevision: previous.revision, confirmed: true }); await this.Refresh(); }
    }
    public async Supplement(item: CartSelection): Promise<void> {
        await this.Client.Request({ operation: 'cart-supplement', seq: item.seq, expectedRevision: item.revision, confirmed: true }); await this.Refresh();
    }
    public async Transfer(): Promise<void> {
        let result: { added: number; existing: number; review: number };
        try { result = await this.Client.Request({ operation: 'cart-transfer' }); } catch(error) { await this.Refresh().catch(() => {}); throw error; }
        this.State.Value = { ...this.State.Value, message: `${result.added} added · ${result.existing} already queued · ${result.review} need review`, error: '' }; await this.Refresh();
    }
}
let cart: SelectionCartController;
export const GetSelectionCart = () => cart ??= new SelectionCartController();
export function CartCount(item: CartSelection): string {
    const total = item.chapterCount ?? item.chapters?.length;
    if (item.mode === 'selected') return `${item.ids.length}/${total ?? 'Unknown'}`;
    if (total === undefined) return 'All · Unknown';
    return `${total - (item.mode === 'except' ? item.ids.length : 0)}/${total}`;
}

export function CartPartial(item: CartSelection): boolean { const count = CartSelectedCount(item), total = item.chapterCount ?? item.chapters?.length; return count !== 0 && (count === undefined ? item.mode === 'except' && item.ids.length > 0 : total === undefined || count < total); }

export function CartSelectedCount(item: CartSelection): number | undefined { if (item.mode === 'selected') return item.ids.length; const total = item.chapterCount ?? item.chapters?.length; return total === undefined ? undefined : total - (item.mode === 'except' ? item.ids.length : 0); }
