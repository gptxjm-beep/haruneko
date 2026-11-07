import type { ArchivePreferences } from './ArchiveUIContract';
export interface MangaReference { siteId: string; mangaId: string; title: string; siteName: string; }
export type QueueScope = { mode: 'all' | 'missing' } | { mode: 'range'; from: number; to: number };
export const QueueScopeLabels = Object.freeze({
    all: 'All — discovered chapters; reuse healthy files',
    missing: 'Missing — same as All today (legacy alias)',
    range: 'Verified chapter range',
});
export const QueueScopeNotice = 'All and Missing currently use the same saved manifest and reuse healthy files. Resume does not expand a saved manifest or discover chapters added after completion.';
export type QueueState = 'Queued' | 'Preparing' | 'Downloading' | 'Paused' | 'Review' | 'Failed' | 'Completed' | 'Cancelled';
export interface SelectedManga extends MangaReference { seq: number; }
export interface QueueMembership { selected: boolean; queued: boolean; }
export interface QueueManga extends SelectedManga {
    state: QueueState; reason: string; sessionId: string | null; scope: QueueScope;
    inCurrentRun?: boolean;
    progress?: { registered: number; verified: number; bytes: number; chapter: string | null; storage: string | null };
}
export interface QueueSnapshot { selected: number; queued: number; state: string; reason: string; mangasUsed: number; chaptersStarted: number; preferences: ArchivePreferences | null; rootLabel: string; batchId: string | null; waitingNextRun: number; }
export type SelectiveQueueCommand =
    | { operation: 'queue-summary' }
    | { operation: 'queue-selections'; after?: number }
    | { operation: 'queue-list'; offset?: number }
    | { operation: 'queue-selected'; references: MangaReference[] }
    | { operation: 'queue-select'; reference: MangaReference; selected: boolean }
    | { operation: 'queue-add'; reference?: MangaReference }
    | { operation: 'queue-edit'; seq: number; action: 'remove' | 'up' | 'down'; scope?: QueueScope }
    | { operation: 'queue-open'; preferences: ArchivePreferences; confirmed: boolean }
    | { operation: 'queue-next' }
    | { operation: 'queue-stop'; state: 'Paused' | 'Cancelled' | 'Failed'; reason: string }
    | { operation: 'queue-result'; seq: number; reason?: string };
