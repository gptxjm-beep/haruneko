import { readFile, open, copyFile, rename, stat, unlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ResolveArchivePath, Fingerprint } from './ArchivePaths';
import { RenderMangaMetadata, ValidateMangaMetadata, type MangaMetadata } from './MangaMetadata';
import { CoverExtension, type MangaDetailsFiles } from './MangaDetailsFiles';
import type { ArchiveRepository } from './ArchiveRepository';
import type { ArchiveStorageController } from './ArchiveStorageController';
export interface MangaInfoDraft { metadata: MangaMetadata; jsonTag: string | null; htmlTag: string | null; warning?: string; }
/** Main-owned paths, optimistic revision checks, explicit consent and preserved backups. */
export class MangaInfoEditor {
    constructor(private readonly repository: ArchiveRepository, private readonly details: MangaDetailsFiles, private readonly storage: ArchiveStorageController, private readonly validateCover: (bytes: Uint8Array) => boolean = bytes => !!CoverExtension(bytes)) {}
    private async Tag(root: string, relative: string) { try { return (await Fingerprint(root, relative)).sha256; } catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
    private async Context(seq: number) {
        const c = this.details.Context(seq), manga = c.folder.slice(0, -'/00 - Manga Details'.length);
        return { ...c, manga, json: `${c.folder}/metadata.json`, html: `${manga}/00 - Manga Details.html` };
    }
    public async Read(seq: number): Promise<MangaInfoDraft> {
        await this.Folder(seq);
        const c = await this.Context(seq);
        const jsonTag = await this.Tag(c.root, c.json), htmlTag = await this.Tag(c.root, c.html);
        let metadata: MangaMetadata = { schema: 1, title: String(c.row.title), sourceName: String(c.row.site_name), fields: {} };
        if (jsonTag) {
            const file = await ResolveArchivePath(c.root, c.json);
            if ((await stat(file)).size > 1024 ** 2) throw new Error('Metadata is too large to edit');
            metadata = ValidateMangaMetadata(JSON.parse(await readFile(file, 'utf8')));
        }
        let warning: string | undefined;
        try { const details = await readdir(path.dirname(await ResolveArchivePath(c.root, `${c.folder}/metadata.json`))); if (details.some(name => /^edit-journal-[a-f0-9-]+\.json$/.test(name) && !details.includes(name.replace('journal-', 'complete-')))) warning = 'An unfinished information edit needs review. Reload and regenerate after checking the current files.'; } catch { /* A first edit has no metadata folder yet. */ }
        return { metadata, jsonTag, htmlTag, warning };
    }
    public async Folder(seq: number): Promise<string> {
        let c: Awaited<ReturnType<MangaInfoEditor['Context']>>;
        try { c = await this.Context(seq); } catch(error) { if ((error as Error).message === 'No saved metadata session') throw new Error('Manga folder has not been created yet'); throw error; }
        let owned = this.repository.HasMangaFiles(String(c.session.root_id), String(c.row.site_id), String(c.row.manga_id));
        try { const identity = await readFile(await ResolveArchivePath(c.root, `${c.folder}/identity.json`), 'utf8'); if (identity !== JSON.stringify([c.row.site_id, c.row.manga_id])) throw new Error('Manga identity conflict'); owned = true; } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!owned) throw new Error('Manga folder has not been created yet');
        try { return path.dirname(await ResolveArchivePath(c.root, `${c.manga}/folder-check`)); } catch { throw new Error('Manga folder is unavailable or needs review'); }
    }
    public async Save(seq: number, draft: MangaInfoDraft, confirmed: boolean, cover?: Uint8Array): Promise<void> {
        if (confirmed !== true) throw new Error('Confirm saving and backing up the existing manga information');
        const c = await this.Context(seq), current = await this.Read(seq);
        if (current.jsonTag !== draft.jsonTag || current.htmlTag !== draft.htmlTag) throw new Error('Files changed outside the editor; reload before saving');
        const metadata = ValidateMangaMetadata(draft.metadata);
        // Source identity is immutable; only the displayed fields and title are editable.
        metadata.sourceName = current.metadata.sourceName; metadata.sourceURL = current.metadata.sourceURL;
        if (cover) {
            const extension = CoverExtension(cover); if (!extension || cover.length > 8 * 1024 ** 2) throw new Error('Invalid cover image');
            metadata.cover = `cover-${randomUUID()}.${extension}`;
        } else metadata.cover = current.metadata.cover;
        if (metadata.cover) {
            const data = cover ?? await readFile(await ResolveArchivePath(c.root, `${c.folder}/${metadata.cover}`));
            if (data.length > 8 * 1024 ** 2 || !CoverExtension(data) || !this.validateCover(data)) throw new Error('Cover is invalid or exceeds the size limit');
        }
        const payloads: [string, Uint8Array, string | null][] = [
            [c.json, new TextEncoder().encode(JSON.stringify(metadata, null, 2)), current.jsonTag],
            [c.html, new TextEncoder().encode(RenderMangaMetadata(metadata, '00 - Manga Details/')), current.htmlTag],
        ];
        if (cover) payloads.unshift([`${c.folder}/${metadata.cover}`, cover, null]);
        await this.storage.Metadata(String(c.session.id), payloads.reduce((sum, [, bytes]) => sum + bytes.length * 3, 0));
        const identity = await ResolveArchivePath(c.root, `${c.folder}/identity.json`, true);
        try { const witness = await open(identity, 'wx', 0o600); try { await witness.writeFile(JSON.stringify([c.row.site_id, c.row.manga_id])); await witness.sync(); } finally { await witness.close(); } } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const staged: { target: string; temporary: string; relative: string; tag: string | null; backup?: string }[] = [];
        for (const [relative, bytes, tag] of payloads) {
            const temporary = await ResolveArchivePath(c.root, `${c.folder}/pending-${randomUUID()}.dat`, true);
            const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
            try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
            staged.push({ temporary, relative, tag, backup: tag ? await ResolveArchivePath(c.root, `${c.folder}/backup-${randomUUID()}.dat`, true) : undefined, target: await ResolveArchivePath(c.root, relative, true) });
        }
        const editId = randomUUID();
        const journal = await open(await ResolveArchivePath(c.root, `${c.folder}/edit-journal-${editId}.json`, true), 'wx', 0o600);
        try { await journal.writeFile(JSON.stringify({ schema: 1, id: editId, files: staged.map(file => ({ relative: file.relative, expected: file.tag, pending: path.basename(file.temporary), backup: file.backup ? path.basename(file.backup) : null })) })); await journal.sync(); } finally { await journal.close(); }
        // Staged files and backups survive a partial publication. Do not claim a cross-file atomic commit.
        try {
            for (const file of staged) {
                this.repository.VerifyRoot(String(c.session.root_id));
                if (await this.Tag(c.root, file.relative) !== file.tag) throw new Error('Files changed during save; pending data retained for review');
                if (file.tag) await copyFile(file.target, file.backup!, constants.COPYFILE_EXCL);
                if (file.tag === null) {
                    const out = await open(file.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
                    try { await out.writeFile(await readFile(file.temporary)); await out.sync(); } finally { await out.close(); }
                    await unlink(file.temporary);
                } else await rename(file.temporary, file.target);
            }
            const saved: { name: string; size: number; sha256: string }[] = c.saved.files ?? [];
            if (metadata.cover) {
                const receipt = await Fingerprint(c.root, `${c.folder}/${metadata.cover}`);
                if (receipt.size > 8 * 1024 ** 2) throw new Error('Cover exceeds the size limit');
                const bytes = await readFile(await ResolveArchivePath(c.root, `${c.folder}/${metadata.cover}`));
                if (!CoverExtension(bytes)) throw new Error('Cover is not an image');
                const old = saved.findIndex(file => file.name === metadata.cover); if (old >= 0) saved.splice(old, 1);
                saved.push({ name: metadata.cover, size: receipt.size, sha256: receipt.sha256 });
            }
            this.repository.Queue.SaveMetadataDetails(seq, { ...c.saved, state: 'Saved', files: saved, coverName: metadata.cover });
            const complete = await open(await ResolveArchivePath(c.root, `${c.folder}/edit-complete-${editId}.json`), 'wx', 0o600);
            try { await complete.writeFile(JSON.stringify({ id: editId, completedAt: Date.now() })); await complete.sync(); } finally { await complete.close(); }
        } catch(error) {
            try { this.repository.Queue.SaveMetadataDetails(seq, { ...c.saved, state: 'Partial', pendingEdit: editId }); } catch { /* The durable journal still identifies a failed metadata publication. */ }
            throw error;
        }
    }
}
