// Bundle the main-only code and exercise it under the Electron binary actually installed.
import { rolldown } from 'rolldown';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'haruneko-archive-runtime-'));
try {
    const bundle = await rolldown({ input: path.resolve('test/archive-runtime-entry.mjs'), platform: 'node', external: id => id.startsWith('node:') });
    const entry = path.join(temporary, 'archive-tests.mjs');
    await bundle.write({ file: entry, format: 'es' });
    await bundle.close();
    const executable = path.resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    const result = spawnSync(executable, [entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 120_000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
