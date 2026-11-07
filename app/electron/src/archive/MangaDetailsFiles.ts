import { open, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { ResolveArchivePath, Fingerprint } from './ArchivePaths';
import type { ArchiveRepository } from './ArchiveRepository';
import type { ArchiveStorageController } from './ArchiveStorageController';
import { SanitizeFileName } from '../../../../web/src/engine/FileName';

export function CoverExtension(bytes: Uint8Array): string | undefined {
    const prefix = Buffer.from(bytes.subarray(0, 16));
    if (prefix.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
    if (prefix.subarray(0, 3).toString('hex') === 'ffd8ff') return 'jpg';
    if (/^GIF8[79]a/.test(prefix.toString())) return 'gif';
    if (prefix.toString().startsWith('BM')) return 'bmp';
    if (prefix.toString().startsWith('RIFF') && prefix.subarray(8, 12).toString() === 'WEBP') return 'webp';
    if (prefix.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(prefix.subarray(8).toString())) return 'avif';
}

export class MangaDetailsFiles {
    constructor(private readonly repository: ArchiveRepository, private readonly storage: ArchiveStorageController) {}
    private Context(seq: number) {
        const row = this.repository.Queue.Details(seq), session = this.repository.Session(row.session_id), settings = session.settings;
        const folder = [settings.useWebsiteSubDirectory ? SanitizeFileName(row.site_name) : '', SanitizeFileName(row.title), '00 - Manga Details'].filter(Boolean).join('/');
        return { row, session, folder, root: this.repository.VerifyRoot(String(session.root_id)), saved: JSON.parse(String(row.scope))._details ?? { files: [] } };
    }
    public async Inspect(seq: number): Promise<{ coverHealthy: boolean; state: string }> {
        const c = this.Context(seq); let coverHealthy = false;
        for (const file of c.saved.files ?? []) if (/^cover\.(png|jpg|gif|webp|avif|bmp)$/.test(file.name)) {
            try { const current = await Fingerprint(c.root, `${c.folder}/${file.name}`); coverHealthy ||= current.sha256 === file.sha256 && current.size === file.size; } catch { /* Unknown files remain protected. */ }
        }
        return { coverHealthy, state: c.saved.state ?? 'Unavailable' };
    }
    public async Save(seq: number, input: { text?: string; cover?: Uint8Array; extension?: string; partial: boolean }): Promise<string> {
        if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 1000000) || input.cover && (!(input.cover instanceof Uint8Array) || input.cover.byteLength > 8 * 1024 ** 2)) throw new Error('Invalid details payload');
        if (input.cover) {
            const extension = CoverExtension(input.cover);
            input = extension ? { ...input, extension } : { ...input, cover: undefined, partial: true };
        }
        const c = this.Context(seq);
        await this.storage.CheckSession(String(c.session.id), BigInt((input.text?.length ?? 0) * 2 + (input.cover?.length ?? 0) + 1024 ** 2));
        const identity = JSON.stringify([c.row.site_id, c.row.manga_id]);
        const witness = await ResolveArchivePath(c.root, `${c.folder}/identity.json`, true);
        try { if (await readFile(witness, 'utf8') !== identity) throw new Error('Manga detail name conflict'); }
        catch(error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const existing = await readdir(witness.slice(0, -'identity.json'.length));
            if (existing.length) throw new Error('Existing unowned details directory needs review');
            const file = await open(witness, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
            try { await file.writeFile(identity); await file.sync(); } finally { await file.close(); }
        }
        const files = [...c.saved.files ?? []]; let protectedOutput = false;
        const write = async (name: string, bytes: Uint8Array) => {
            this.repository.VerifyRoot(String(c.session.root_id));
            const target = await ResolveArchivePath(c.root, `${c.folder}/${name}`, true);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            try {
                const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
                try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
            } catch(error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const old = await Fingerprint(c.root, `${c.folder}/${name}`);
                if (old.sha256 !== sha256 || old.size !== bytes.length) { protectedOutput = true; return; }
            }
            this.repository.VerifyRoot(String(c.session.root_id));
            if (!files.some(file => file.name === name && file.sha256 === sha256)) files.push({ name, size: bytes.length, sha256 });
        };
        // Independent components: a text failure must not prevent a usable cover, or vice versa.
        for (const [name, bytes] of [['details.txt', input.text ? new TextEncoder().encode(input.text) : undefined], [`cover.${input.extension}`, input.cover]] as const) {
            if (bytes) { try { await write(name, bytes); } catch { protectedOutput = true; } }
        }
        const state = files.length ? input.partial || protectedOutput ? 'Partial' : 'Saved' : 'Unavailable';
        this.repository.Queue.SaveDetails(seq, { state, files }); return state;
    }
}
