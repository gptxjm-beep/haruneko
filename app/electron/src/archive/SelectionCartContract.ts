import type { MangaReference, QueueScope } from './SelectiveQueueContract';
export interface CartChapter { id: string; title: string; }
export interface CartSelection extends MangaReference {
    seq: number; revision: number; mode: 'all' | 'selected' | 'except'; ids: string[];
    chapters?: CartChapter[]; direction?: 'ascending' | 'descending'; order: 'source' | 'first-last' | 'last-first';
    reason?: string;
}
export type CartCommand =
    | { operation: 'cart-list'; after?: number }
    | { operation: 'cart-save'; reference: MangaReference; expectedRevision: number; selection: Pick<CartSelection, 'mode' | 'ids' | 'order' | 'direction' | 'chapters'> }
    | { operation: 'cart-remove'; seq: number; expectedRevision: number; confirmed: boolean }
    | { operation: 'cart-clear'; confirmed: boolean }
    | { operation: 'cart-transfer' };
export function CartQueueScope(item: CartSelection): QueueScope {
    if (item.reason) throw new Error('Source chapter identities changed; review this selection');
    const sourceIds = item.chapters?.map(chapter => chapter.id);
    const policy = { order: item.order, direction: item.direction, sourceIds };
    if (item.mode === 'all') return { mode: 'all', ...policy };
    if (item.mode === 'except' && !sourceIds) throw new Error('Load chapters before transferring exclusions');
    return { mode: 'selected', ids: item.mode === 'selected' ? item.ids : sourceIds!.filter(id => !item.ids.includes(id)), ...policy };
}
