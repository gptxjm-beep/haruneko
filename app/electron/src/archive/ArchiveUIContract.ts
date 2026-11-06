import type { ArchivePolicy, ArchiveRunSnapshot } from './ArchiveCoordinatorProtocol';
export const ArchiveFormats = Object.freeze({ RAW: 'image/*', CBZ: 'application/x-cbz', EPUB: 'application/epub+zip', PDF: 'application/pdf' });
export interface ArchivePreferences {
    rootId: string | null;
    format: string;
    useWebsiteSubDirectory: boolean;
    reserveGiB: number;
    policy: ArchivePolicy;
}
export const DefaultArchivePreferences: ArchivePreferences = { rootId: null, format: ArchiveFormats.CBZ, useWebsiteSubDirectory: true,
    reserveGiB: 50, policy: { maxMangas: 5, maxChapters: 20, delayMs: 1000, retryDelayMs: 5000, maxAttempts: 2, languages: [], unknownLanguage: 'review' } };
export interface ArchiveUISession {
    id: string; cursor: number; siteId: string; siteName: string; rootLabel: string; createdAt: number;
    format: string; snapshot: ArchiveRunSnapshot;
}
export interface ArchiveUIProgress extends ArchiveUISession {
    currentManga: string | null; currentChapter: string | null;
    discoveredMangas: number; registeredChapters: number; verifiedChapters: number; writtenBytes: number;
    events: { id: number; kind: string; reason: string; at: number }[];
    errors: { stage: string; message: string }[];
}
export type ArchiveUICommand =
    | { operation: 'ui-preferences' }
    | { operation: 'ui-save-preferences'; preferences: ArchivePreferences }
    | { operation: 'ui-create-session'; siteId: string; siteName: string; preferences: ArchivePreferences; confirmed: boolean }
    | { operation: 'ui-sessions'; before?: number }
    | { operation: 'ui-progress'; sessionId: string };
