import { describe, expect, it, vi } from 'vitest';
import { ImageDirectoryExporter } from './ImageDirectoryExporter';
import { ArchiveCapacityError, type ExportContext } from '../DownloadContract';
import type { StorageController } from '../StorageController';

describe('RAW archive storage failures', () => {
    it('Should propagate capacity failure when another page also failed for an unrelated reason', async () => {
        const capacity = new ArchiveCapacityError('Disk full', { code: 'write-full', location: 'archive' });
        const storage = { LoadTemporary: vi.fn().mockResolvedValue(new Blob(['page'], { type: 'image/png' })) } as unknown as StorageController;
        const context = { signal: new AbortController().signal, writing: vi.fn(), written: vi.fn(),
            write: async (path: string) => { throw path.endsWith('1.png') ? new Error('Existing path conflict') : capacity; } } as unknown as ExportContext;
        await expect(new ImageDirectoryExporter(storage).Export(new Map([[0, 'a'], [1, 'b']]), undefined, 'Chapter', 'Manga', context)).rejects.toBe(capacity);
    });
});
