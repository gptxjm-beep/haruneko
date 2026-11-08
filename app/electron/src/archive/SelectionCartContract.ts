import type { MangaReference, QueueScope } from './SelectiveQueueContract';
export interface CartChapter { id: string; title: string; }
export interface CartSelection extends MangaReference {
    seq: number; revision: number; mode: 'all' | 'selected' | 'except'; ids: string[];
    chapterCount?: number; chapters?: CartChapter[]; direction?: 'ascending' | 'descending'; order: 'source' | 'first-last' | 'last-first';
    reason?: string;
}
export type CartCommand =
    | { operation: 'cart-list'; after?: number }
    | { operation: 'cart-save'; reference: MangaReference; expectedRevision: number; selection: Pick<CartSelection, 'mode' | 'ids' | 'order' | 'direction' | 'chapters'> }
    | { operation: 'cart-remove'; seq: number; expectedRevision: number; confirmed: boolean }
    | { operation: 'cart-clear'; confirmed: boolean }
    | { operation: 'cart-transfer' }
    | { operation: 'cart-supplement'; seq: number; expectedRevision: number; confirmed: boolean };
export function CartQueueScope(item: CartSelection): QueueScope {
    const sourceIds = item.chapters?.map(chapter => chapter.id);
    const policy = { order: item.order, direction: item.direction, sourceIds };
    if (item.mode === 'all') return { mode: 'all', ...policy };
    if (item.mode === 'except' && !sourceIds) throw new Error('Load chapters before transferring exclusions');
    const excluded = new Set(item.ids);
    return { mode: 'selected', ids: item.mode === 'selected' ? item.ids : sourceIds!.filter(id => !excluded.has(id)), ...policy };
}
