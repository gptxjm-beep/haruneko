import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
export async function PreparePreview(allowDirty = false) {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repo, encoding: 'utf8' }).trim();
    if (dirty && !allowDirty) throw new Error('Preview packaging requires a committed clean worktree');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    for (const workspace of ['web', 'app/electron']) execFileSync(npm, ['run', 'build', `--workspace=${workspace}`], { cwd: repo, env: { ...process.env, VITE_ENHANCED_PREVIEW: '1' }, stdio: 'inherit', shell: process.platform === 'win32' });
    const output = path.join(repo, 'app/electron/bundle'); await fs.mkdir(output, { recursive: true });
    const appPath = await fs.mkdtemp(path.join(output, 'preview-app-'));
    await fs.cp(path.join(repo, 'app/electron/build'), appPath, { recursive: true });
    await fs.cp(path.join(repo, 'web/build'), path.join(appPath, 'web'), { recursive: true });
    const pkg = JSON.parse(await fs.readFile(path.join(appPath, 'package.json'), 'utf8'));
    pkg.name = 'haruneko-enhanced-preview'; pkg.enhancedPreview = true; delete pkg.url; delete pkg['user-data-dir'];
    await fs.writeFile(path.join(appPath, 'package.json'), JSON.stringify(pkg, null, 2));
    const indexFile = path.join(appPath, 'web/index.html');
    await fs.writeFile(indexFile, (await fs.readFile(indexFile, 'utf8')).replace(/<title>[^<]*<\/title>/, '<title>HaruNeko Enhanced Preview</title>'));
    const assets = {};
    async function Scan(directory, prefix = '') {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const name = prefix + entry.name; const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Preview assets cannot be symlinks');
            if (entry.isDirectory()) await Scan(file, name + '/');
            else assets[name] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
        }
    }
    await Scan(path.join(appPath, 'web'));
    const electron = JSON.parse(await fs.readFile(path.join(repo, 'app/electron/package.json'), 'utf8')).devDependencies.electron;
    await fs.writeFile(path.join(appPath, 'preview-manifest.json'), JSON.stringify({ schema: 1, commit, dirty, electron, assets }, null, 2));
    await fs.writeFile(path.join(output, 'preview-last.json'), JSON.stringify({ appPath, commit, dirty, electron }, null, 2));
    console.log(JSON.stringify({ previewApp: appPath, commit, dirty }));
    return { appPath, commit, dirty, electron, output };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await PreparePreview(process.argv.includes('--allow-dirty'));
