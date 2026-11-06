// CI-readable failure checkpoint. Same integration command/assertions/timeouts; no user profile or live-site data.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
const chunks = [];
const child = spawn(process.execPath, ['test/archive-electron.mjs'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const capture = (data, stream) => { stream.write(data); chunks.push(data.toString()); while (chunks.join('').length > 2 * 1024 * 1024) chunks.shift(); };
child.stdout.on('data', data => capture(data, process.stdout)); child.stderr.on('data', data => capture(data, process.stderr));
let launchError;
const code = await new Promise(resolve => { child.once('error', error => { launchError = error; resolve(1); }); child.once('exit', status => resolve(status ?? 1)); });
const clean = value => String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/https?:\/\/\S+/gi, '[source]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/tmp\/)[^\r\n]*/g, '[test-path]').replace(/\b(cookie|authorization|token|password|secret)\s*[:=].*/gi, '$1=[redacted]');
const lines = chunks.join('').split(/\r?\n/), last = lines.filter(line => /^renderer: .* true$/.test(line)).at(-1);
const failure = lines.find(line => /^(?:AssertionError|TypeError|ReferenceError|TimeoutError|Error)(?:\s*\[|:)/.test(line));
const report = { platform: process.platform, success: code === 0, lastPassed: clean(last).slice(0, 350), failure: code ? clean(failure ?? launchError?.message ?? 'Integration process exited without a diagnostic').slice(0, 350) : null };
await fs.mkdir('app/electron/bundle', { recursive: true });
await fs.writeFile('app/electron/bundle/windows-electron-integration.json', JSON.stringify(report, null, 2));
await fs.writeFile('app/electron/bundle/windows-electron-integration.log', clean(chunks.join('')));
if (code && process.env.GITHUB_ACTIONS) {
    const message = `${report.failure}; last passed: ${report.lastPassed}`.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error title=Windows Electron checkpoint::${message}`);
}
process.exitCode = code;
