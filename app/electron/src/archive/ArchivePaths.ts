import path from 'node:path';
import fs from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export function ErrorCode(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function ErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function Text(value: unknown, label: string, max = 2048): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${label}`);
    return value;
}

export function Count(value: unknown, label: string, max = 1_000_000): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error(`Invalid ${label}`);
    return Number(value);
}

export function RelativePath(value: unknown): string {
    const name = Text(value, 'relative path', 4096);
    if (name.includes('\\') || name.startsWith('/') || name.includes(':')) throw new Error('Absolute paths and traversal are forbidden');
    const segments = name.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.length > 255
        || /[<>"|?*]/.test(segment) || /[. ]$/.test(segment) || /^\.haruneko-/i.test(segment)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Unsafe archive path');
    return name;
}

export function PathKey(value: string): string { return RelativePath(value).normalize('NFC').toLowerCase(); }

export function IsWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** No renderer-controlled absolute path, symlink, junction or non-directory parent is accepted. */
export async function ResolveArchivePath(root: string, relative: string, createParents = false): Promise<string> {
    const parts = RelativePath(relative).split('/');
    const before = await lstat(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Archive root changed');
    const canonical = await realpath(root);
    const [resolved, after] = await Promise.all([lstat(canonical, { bigint: true }), lstat(root, { bigint: true })]);
    // Native Windows realpath can expand short names and normalize casing. Directory identity,
    // not textual spelling or lowercasing, proves that normalization stayed on the same object.
    if (!resolved.isDirectory() || resolved.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink()
        || before.dev !== resolved.dev || before.ino !== resolved.ino || before.dev !== after.dev || before.ino !== after.ino) throw new Error('Archive root changed');
    root = canonical;
    let current = root;
    for (const part of parts.slice(0, -1)) {
        current = path.join(current, part);
        if (createParents) {
            try { await fs.promises.mkdir(current, { mode: 0o700 }); } catch(error) { if (ErrorCode(error) !== 'EEXIST') throw error; }
        }
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory() || !IsWithin(root, await realpath(current))) throw new Error('Unsafe archive parent');
    }
    const target = path.join(current, parts[parts.length - 1]);
    if (!IsWithin(root, target)) throw new Error('Archive path escaped its root');
    try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isFile() || !IsWithin(root, await realpath(target))) throw new Error('Unsafe archive file');
    } catch(error) { if (ErrorCode(error) !== 'ENOENT') throw error; }
    return target;
}

export async function Fingerprint(root: string, relative: string): Promise<{ size: number; sha256: string; stamp: string }> {
    const target = await ResolveArchivePath(root, relative);
    const file = await open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const before = await file.stat({ bigint: true });
        const named = await lstat(target, { bigint: true });
        if (!before.isFile() || before.ino !== named.ino || before.dev !== named.dev || !IsWithin(root, await realpath(target))) throw new Error('Archive file changed during open');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (true) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
        const after = await file.stat({ bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || offset !== Number(after.size)) throw new Error('Archive file changed during hashing');
        return { size: offset, sha256: hash.digest('hex'), stamp: `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` };
    } finally { await file.close(); }
}

export function SafeMessage(value: unknown): string {
    return String(value).slice(0, 2048)
        .replace(/https?:\/\/[^\s]+/g, raw => { try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[url]'; } })
        .replace(/\b(authorization|cookie|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}
