import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CatalogLogs, CleanCatalogDiagnostic } from './CatalogLogs';
describe('Catalog JSONL diagnostics', () => {
    it('Should persist successive events and redact URLs and credentials', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-log-'));
        try {
            const logs = new CatalogLogs(directory), id = '00000000-0000-0000-0000-000000000001';
            await logs.Write(id, { event: 'begin', type: 'full-refresh' });
            await logs.Write(id, { event: 'failure', diagnostic: 'HTTP403 https://example.invalid/?token=private', cookie: 'private' });
            const data = await readFile(path.join(directory, `${id}.jsonl`), 'utf8');
            expect(data.trim().split('\n')).toHaveLength(2); expect(data).not.toContain('private'); expect(data).toContain('failure');
            await expect(logs.Write('../escape', {})).rejects.toThrow();
            expect(JSON.stringify(CleanCatalogDiagnostic({ diagnostic: 'Authorization: Bearer private' }))).not.toContain('private');
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
