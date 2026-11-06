// Own temporary fixtures only. Public output excludes absolute paths, raw errors and response data.
import fs from 'node:fs/promises';
import native from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const repo = process.cwd();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'haruneko-ci-diagnostics-'));
const generated = path.join(repo, 'web/src/engine', `__windows_batch_${randomUUID().replaceAll('-', '')}_test.ts`);
const report = { platform: process.platform, node: process.versions.node, pathRepresentation: {}, isolated: [], batchMilliseconds: [], batchBudgetMs: 5000, nativeZeroTimer100Ms: null, nativeFiveTimer100Ms: null, success: false };
const vitest = path.join(repo, 'node_modules/vitest/vitest.mjs');
let generatedOwned = false;
function Category(messages) {
    const value = messages.join(' ');
    return /Archive root changed/.test(value) ? 'archive-root-changed' : /ENOENT/.test(value) ? 'missing-fixture-output'
        : /timed out|timeout/i.test(value) ? 'timeout' : 'assertion-or-execution';
}
async function Run(name, workspace, files, extra = []) {
    const json = path.join(temporary, `${report.isolated.length}.json`);
    const start = performance.now();
    const child = spawnSync(process.execPath, [vitest, 'run', ...files, ...extra, '--reporter=json', `--outputFile=${json}`], {
        cwd: path.join(repo, workspace), encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    let results = [];
    try { results = JSON.parse(await fs.readFile(json, 'utf8')).testResults.flatMap(suite => suite.assertionResults); } catch { /* Report execution failure without raw paths or command stderr. */ }
    const failures = results.filter(test => test.status === 'failed').map(test => ({ test: test.fullName, category: Category(test.failureMessages ?? []) }));
    const passed = results.filter(test => test.status === 'passed');
    const result = { name, success: child.status === 0 && passed.length > 0, passed: passed.length, elapsedMs: Math.round(performance.now() - start),
        cases: passed.map(test => ({ test: test.fullName, milliseconds: test.duration })), failures };
    report.isolated.push(result); console.log(JSON.stringify(result));
    return result;
}
try {
    const timerStart = performance.now();
    for (let index = 0; index < 100; index++) await new Promise(resolve => setTimeout(resolve, 0));
    report.nativeZeroTimer100Ms = Math.round(performance.now() - timerStart);
    const lockTimerStart = performance.now();
    for (let index = 0; index < 100; index++) await new Promise(resolve => setTimeout(resolve, 5));
    report.nativeFiveTimer100Ms = Math.round(performance.now() - lockTimerStart);
    const directory = path.join(temporary, 'MiXeD Root'); await fs.mkdir(directory);
    const input = process.platform === 'win32' ? directory.toUpperCase() : directory + path.sep + '.';
    const legacy = native.realpathSync(input); const sync = native.realpathSync.native(input); const asyncPath = await fs.realpath(input);
    const first = await fs.stat(input, { bigint: true }); const second = await fs.stat(asyncPath, { bigint: true });
    // Case folding here labels a diagnostic difference only; filesystem authorization uses dev/ino.
    report.pathRepresentation = { legacyEqualsNative: legacy === sync, nativeSyncEqualsAsync: sync === asyncPath, legacyEqualityWouldReject: legacy !== asyncPath,
        suppliedSpellingDiffers: input !== asyncPath, caseOnlyDifference: legacy !== asyncPath && legacy.toUpperCase() === asyncPath.toUpperCase(), legacyHasShortComponent: /~[0-9]+(?:[\\/]|$)/.test(legacy), nativeHasShortComponent: /~[0-9]+(?:[\\/]|$)/.test(asyncPath), sameDevice: first.dev === second.dev, sameDirectory: first.ino === second.ino };
    console.log(JSON.stringify({ pathRepresentation: report.pathRepresentation }));
    await Run('archive-paths-and-storage', 'app/electron', ['src/archive/ArchivePaths_test.ts', 'src/archive/ArchiveStorageController_test.ts', 'src/archive/ArchiveWorkRepository_test.ts']);
    await Run('archive-manager-alone', 'web', ['src/engine/archive/ArchiveManager_test.ts']);
    await Run('archive-download-alone', 'web', ['src/engine/archive/ArchiveDownload_test.ts']);
    // Replay the originally failing 500-task test with native timers, without changing its assertions.
    const baseline = execFileSync('git', ['show', '1fdd3308d71fe11a5198f3deb476ffee8a088e49:web/src/engine/DownloadContract_test.ts'], { cwd: repo, encoding: 'utf8' });
    await fs.writeFile(generated, baseline, { flag: 'wx' });
    generatedOwned = true;
    for (let index = 0; index < 3; index++) {
        const measured = await Run(`batch-500-native-timers-${index + 1}`, 'web', [path.relative(path.join(repo, 'web'), generated)], ['-t', 'Should.release.a.large.batch', '--testTimeout=15000']);
        if (measured.success && measured.cases.length === 1 && Number.isFinite(measured.cases[0].milliseconds)) report.batchMilliseconds.push(measured.cases[0].milliseconds);
    }
    report.success = report.isolated.every(result => result.success) && report.batchMilliseconds.length === 3;
    if (report.success) {
        // A single measured CI test budget, never a global timeout or a production setting.
        report.batchBudgetMs = Math.min(15000, Math.max(5000, Math.ceil((Math.max(...report.batchMilliseconds) * 1.5 + 1000) / 1000) * 1000));
        if (process.platform === 'win32' && process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, `HARUNEKO_WINDOWS_BATCH_TIMEOUT_MS=${report.batchBudgetMs}\n`);
    }
} finally {
    if (generatedOwned) await fs.rm(generated, { force: true });
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(path.join(repo, 'app/electron/bundle'), { recursive: true });
    await fs.writeFile(path.join(repo, 'app/electron/bundle/windows-ci-diagnostics.json'), JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Windows isolated diagnostics\n\nPlatform: ${report.platform}; success: ${report.success}. Native 100 zero-delay timers: ${report.nativeZeroTimer100Ms} ms; 100 five-ms lock timers: ${report.nativeFiveTimer100Ms} ms.\n\nNative-timer 500-task samples (ms): ${report.batchMilliseconds.map(value => Math.round(value)).join(', ')}.\n\nMeasured budget for this test only: ${report.batchBudgetMs} ms (hard maximum 15000).\n\nPath equality/identity flags: ${JSON.stringify(report.pathRepresentation)}\n`);
}
if (!report.success) process.exitCode = 1;
