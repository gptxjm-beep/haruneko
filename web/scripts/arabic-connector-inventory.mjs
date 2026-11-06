// Static inventory only: never imports a connector or contacts a website.
import ts from 'typescript';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../src/engine/websites/', import.meta.url));
const index = await readFile(path.join(directory, '_index.ts'), 'utf8');
const registered = new Set([...index.matchAll(/from\s+'\.\/([^']+)'/g)].map(match => match[1] + '.ts'));
const rows = [];
async function Scan(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
        const filename = path.join(current, entry.name);
        if (entry.isDirectory()) { await Scan(filename); continue; }
        if (!entry.name.endsWith('.ts') || /_(?:test|e2e)\.ts$/.test(entry.name)) continue;
        const text = await readFile(filename, 'utf8');
        const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
        const languages = new Set(); let metadata;
        function Visit(node) {
            if (ts.isPropertyAccessExpression(node) && ['Tags.Language.Arabic', 'Tags.Language.Multilingual'].includes(node.getText(source))) languages.add(node.name.text);
            if (!metadata && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword && node.arguments.length >= 3
                && node.arguments.slice(0, 3).every(value => ts.isStringLiteralLike(value))) metadata = node.arguments.slice(0, 3).map(value => value.text);
            ts.forEachChild(node, Visit);
        }
        Visit(source);
        if (!languages.size) continue;
        if (!metadata) throw new Error(`Review non-literal connector metadata: ${path.relative(directory, filename)}`);
        const relative = path.relative(directory, filename).replaceAll(path.sep, '/');
        let tests = false;
        try { await readFile(filename.replace(/\.ts$/, '_e2e.ts')); tests = true; } catch { /* No dedicated live fixture. */ }
        rows.push({ file: relative, id: metadata[0], name: metadata[1], url: metadata[2], arabic: languages.has('Arabic'), multilingual: languages.has('Multilingual'),
            registered: registered.has(relative), fixture: relative.startsWith('_mocks_/'), e2e: tests,
            family: /WordPressMadara/.test(text) ? 'Madara' : /Common\./.test(text) ? 'Common/custom' : 'custom',
            priority: ['mangatek', 'mangalover'].includes(metadata[0]) ? 'P1' : languages.has('Arabic') ? 'P2' : 'P3' });
    }
}
await Scan(directory);
rows.sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id));
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else {
    console.log('| المصدر | المعرّف | الرابط المسجل | إعلان اللغة | البنية | الاختبار الحي المسجل | الأولوية |');
    console.log('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows.filter(row => !row.fixture)) console.log(`| ${row.name.replaceAll('|', '\\|')} (${row.file}) | \`${row.id}\` | ${row.url} | ${row.multilingual ? 'متعدد' + (row.arabic ? '؛ العربية معلنة في الشيفرة' : '؛ العربية غير مثبتة بالوسم العام') : 'العربية معلنة'} | ${row.family} | ${row.e2e ? 'موجود؛ لم ينفذ حيًا' : 'لا ملف مخصص'} | ${row.priority} |`);
}
