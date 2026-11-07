import path from 'node:path';
import { mkdir, readdir, lstat, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';

export function CleanCatalogDiagnostic(value: unknown): unknown {
    if (typeof value === 'string') return value.slice(0, 2048).replace(/https?:\/\/[^\s"<>]+/gi, '[source-url]')
        .replace(/(?:[a-z]:[\\/]|\\\\|\/(?:Users|home|tmp)\/)[^\s]+/gi, '[private-path]')
        .replace(/\b(?:cookie|authorization|password|token|secret|session)\s*[:=].*/gi, '[credential-redacted]');
    if (Array.isArray(value)) return value.slice(0, 5000).map(CleanCatalogDiagnostic);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/cookie|authorization|password|token|secret/i.test(key)).slice(0, 40).map(([key, item]) => [key, CleanCatalogDiagnostic(item)]));
    return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null;
}
/** App-owned logs only. Logging never acquires an archive root or accepts renderer paths. */
export class CatalogLogs {
    constructor(public readonly Directory: string) {}
    public async Write(runId: string, event: Record<string, unknown>): Promise<void> {
        if (!/^[a-f0-9-]{36}$/i.test(runId) || !event || typeof event !== 'object' || JSON.stringify(event).length > 32000) throw new Error('Invalid diagnostic event');
        await mkdir(this.Directory, { recursive: true });
        for (const directory of [this.Directory, path.dirname(this.Directory)]) {
            const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe log directory');
        }
        const entries = await readdir(this.Directory);
        const files = [];
        for (const name of entries.filter(name => /^[a-f0-9-]{36}\.jsonl$/i.test(name))) {
            const info = await lstat(path.join(this.Directory, name));
            if (info.isFile() && !info.isSymbolicLink()) files.push({ name, size: info.size, time: info.mtimeMs });
        }
        files.sort((a, b) => b.time - a.time);
        for (const [index, file] of files.entries()) if (file.name !== `${runId}.jsonl` && (index >= 30 || Date.now() - file.time > 30 * 86400000)) await unlink(path.join(this.Directory, file.name));
        const target = path.join(this.Directory, `${runId}.jsonl`);
        const file = await open(target, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
            if ((await file.stat()).size > 2 * 1024 ** 2) return;
            await file.writeFile(JSON.stringify({ runId, at: new Date().toISOString(), ...CleanCatalogDiagnostic(event) as object }) + '\n');
            await file.sync();
        } finally { await file.close(); }
    }
}
