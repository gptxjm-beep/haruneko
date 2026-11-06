import path from 'node:path';
import { readFile } from 'node:fs/promises';
export function ArabicPriorityFixturePlugin() {
    const target = path.resolve('web/src/engine/platform/FetchProvider.ts');
    const virtual = '\0arabic-priority-transport';
    return { name: 'isolated-arabic-priority-transport', enforce: 'pre',
        resolveId(source, importer) {
            if (source === '/__arabic-priority-transport') return virtual;
            const resolved = source.startsWith('.') && importer ? path.resolve(path.dirname(importer.split('?')[0]), source) : source;
            if ([target, target.slice(0, -3), '/src/engine/platform/FetchProvider.ts'].includes(resolved)) return virtual;
        },
        async load(id) { if (id === virtual) return readFile(path.resolve('test/arabic-priority-runtime.mjs'), 'utf8'); },
    };
}
