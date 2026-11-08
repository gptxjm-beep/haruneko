import { Fetch } from '../platform/FetchProvider';
import { ValidateImage, ImageValidationError } from '../ValidateImage';
import type { MangaPlugin } from '../providers/MangaPlugin';
import type { ArchiveClient } from './ArchiveClient';
import { SaveCatalogAliases } from '../catalog/SiteIndexRepository';
import type { QueueManga } from '../../../../app/electron/src/archive/SelectiveQueueContract';
import type { MangaMetadata } from '../../../../app/electron/src/archive/MangaMetadata';

async function LimitedBody(response: Response, maximum: number, signal: AbortSignal): Promise<Blob> {
    if (!response.ok || Number(response.headers.get('Content-Length')) > maximum) { await response.body?.cancel(); throw new Error('Optional response unavailable or too large'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing optional response');
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
    try {
        while (true) {
            signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
            size += part.value.length; if (size > maximum) { await reader.cancel(); throw new Error('Optional response too large'); }
            chunks.push(new Uint8Array(part.value));
        }
        return new Blob(chunks, { type: response.headers.get('Content-Type') ?? '' });
    } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export function MangaDetailsURL(site: URL, id: string): URL {
    let value = id;
    if (id.startsWith('{')) value = JSON.parse(id).slug;
    if (typeof value !== 'string' || !value.includes('/')) throw new Error('Connector does not expose a public manga URL');
    const url = new URL(value, site);
    if (url.origin !== site.origin || !/^https?:$/.test(url.protocol) || url.username || url.password || url.search) throw new Error('Unsupported manga URL');
    url.hash = ''; return url;
}
export function ExtractMangaDetails(document: Document, source?: URL): { fields: Record<string, string>; aliases: string[]; cover?: string; covers: string[] } {
    const fields: Record<string, string> = {}, aliases: string[] = [];
    const text = (value: unknown) => typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000) : '';
    const meta = (key: string) => document.querySelector<HTMLMetaElement>(`meta[property="${key}"],meta[name="${key}"]`)?.content;
    let cover = meta('og:image') || meta('twitter:image');
    const covers: string[] = [];
    const image = document.querySelector<HTMLImageElement>('.summary_image img, .seriestuimg img, .series-thumb img, [itemprop="image"]');
    if (image) {
        const variants = (image.getAttribute('data-srcset') || image.getAttribute('srcset') || '').split(',').map(value => value.trim().split(/\s+/)).toSorted((a, b) => parseFloat(b[1] || '0') - parseFloat(a[1] || '0'));
        covers.push(...variants.map(value => value[0]), image.getAttribute('data-src'), image.getAttribute('data-lazy-src'), image.getAttribute('src'));
    }
    if (meta('og:title')) fields.Title = text(meta('og:title'));
    if (meta('description') || meta('og:description')) fields.Description = text(meta('description') || meta('og:description'));
    const selectors = { Description: '.description-summary .summary__content', Author: '.author-content', Artist: '.artist-content', Genres: '.genres-content' };
    for (const [field, selector] of Object.entries(selectors)) if (!fields[field] && text(document.querySelector(selector)?.textContent)) fields[field] = text(document.querySelector(selector).textContent);
    cover ||= document.querySelector<HTMLImageElement>('.summary_image img')?.getAttribute('data-src') || document.querySelector<HTMLImageElement>('.summary_image img')?.getAttribute('src');
    for (const item of document.querySelectorAll('.post-content_item')) {
        const label = text(item.querySelector('.summary-heading')?.textContent).toLowerCase().replace(/[:：]$/, '').trim();
        const value = text(item.querySelector('.summary-content')?.textContent);
        if (/^(alternative|alternative names|other names|الأسماء الأخرى|اسماء اخرى)$/.test(label) && value) aliases.push(...value.split(/;|\n/).map(value => value.trim()).filter(Boolean));
        if (/^(status|الحالة)$/.test(label) && value) fields.Status = value;
        if (/^(type|النوع)$/.test(label) && value) fields.Type = value;
    }
    const candidates: Record<string, any>[] = [];
    for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 10)) {
        if (script.textContent.length > 100000) continue;
        try {
            const value = JSON.parse(script.textContent), roots = Array.isArray(value) ? value : value?.['@graph'] ?? [value];
            for (const data of roots) if (data && ['ComicSeries', 'Book', 'CreativeWork', 'ComicStory', 'TVSeries'].includes(data['@type'])) candidates.push(data);
        } catch { /* One bad block must not discard another field. */ }
    }
    for (const data of candidates) {
        const identity = typeof data.url === 'string' ? data.url : data['@id'];
        if (source && typeof identity === 'string') {
            try { const url = new URL(identity, source); if (url.origin !== source.origin || url.pathname.replace(/\/$/, '') !== source.pathname.replace(/\/$/, '')) continue; }
            catch { continue; }
        } else if (candidates.length > 1) continue; // Several unidentified works cannot supply safe aliases.
        for (const [field, key] of [['Title', 'name'], ['Description', 'description'], ['Status', 'creativeWorkStatus']]) if (text(data[key])) fields[field] = text(data[key]);
        for (const [field, key] of [['Author', 'author'], ['Artist', 'illustrator']]) {
            const people = Array.isArray(data[key]) ? data[key] : [data[key]];
            const names = people.map(person => text(typeof person === 'string' ? person : person?.name)).filter(Boolean); if (names.length) fields[field] = names.join(', ');
        }
        const genres = Array.isArray(data.genre) ? data.genre : [data.genre]; if (genres.some(text)) fields.Genres = genres.map(text).filter(Boolean).join(', ');
        for (const alias of Array.isArray(data.alternateName) ? data.alternateName : [data.alternateName]) if (text(alias)) aliases.push(text(alias).slice(0, 1024));
        cover ||= typeof data.image === 'string' ? data.image : data.image?.url;
    }
    if (aliases.length) fields['Alternate titles'] = [...new Set(aliases)].join(' / ');
    const story = text(document.querySelector('.description-summary .summary__content, .summary__content, [itemprop="description"], .manga-description')?.textContent);
    const title = text(document.querySelector('.post-title h1, .seriestuheader h1, h1[itemprop="name"]')?.textContent);
    if (title) fields.Title = title;
    if (story) fields.Description = story;
    if (/^(?:read (?:the )?latest|اقرأ أحدث|اقرا احدث|أفضل موقع لقراءة|افضل موقع لقراءة)/i.test(fields.Description ?? '')) delete fields.Description;
    const candidatesCovers = [...new Set([...covers, cover].filter(value => typeof value === 'string' && value.trim() && !value.startsWith('data:')))];
    return { covers: candidatesCovers.slice(0, 5), fields, aliases: [...new Set(aliases)].slice(0, 30), cover };
}
/** Optional, bounded and independent of chapter outcomes. Never scans all manga or source chapters. */
export async function DownloadMangaDetails(site: MangaPlugin, item: QueueManga, client: ArchiveClient, signal: AbortSignal): Promise<void> {
    if (site.Identifier !== item.siteId) throw new Error('Manga details belong to another connector');
    const timeout = AbortSignal.timeout(15000), stop = AbortSignal.any([signal, timeout]);
    const bounded = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
        const abort = () => reject(stop.reason), cleanup = () => stop.removeEventListener('abort', abort);
        stop.addEventListener('abort', abort, { once: true });
        promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (stop.aborted) { cleanup(); abort(); }
    });
    let text = `Saved title: ${item.title}\nSource: ${site.Title}\n`, cover: Uint8Array, extension: string;
    const metadata: MangaMetadata = { schema: 1, title: item.title, sourceName: site.Title, fields: {}, diagnostics: {} };
    let partial = false;
    try {
        const url = MangaDetailsURL(site.URI, item.mangaId); text += `Source URL: ${url.href}\n`;
        metadata.sourceURL = url.href;
        const html = await bounded(LimitedBody(await bounded(Fetch(new Request(url, { signal: stop }))), 2 * 1024 ** 2, stop));
        const data = ExtractMangaDetails(new DOMParser().parseFromString(await html.text(), 'text/html'), url);
        metadata.fields = data.fields; metadata.title = data.fields.Title || item.title;
        metadata.diagnostics.page = 'available'; metadata.diagnostics.description = data.fields.Description ? 'source description extracted; completeness not asserted' : 'not-declared';
        text += Object.entries(data.fields).map(([key, value]) => `${key}: ${value}`).join('\n') + '\n';
        if (data.aliases.length) await SaveCatalogAliases(site.Identifier, item.mangaId, data.aliases).catch(() => {});
        const existing = await client.Request<{ coverHealthy: boolean }>({ operation: 'queue-details-inspect', seq: item.seq });
        if (!existing.coverHealthy) {
            for (const candidate of data.covers) {
                try {
                    const imageURL = new URL(candidate, url);
                    if (!/^https?:$/.test(imageURL.protocol) || imageURL.username || imageURL.password) continue;
                    const response = await bounded(Fetch(new Request(imageURL, { signal: stop, headers: { Referer: url.href } })));
                    const bytes = await bounded(LimitedBody(response, 8 * 1024 ** 2, stop));
                    const valid = await ValidateImage(bytes, stop);
                    extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' }[valid.type];
                    if (!extension) continue;
                    cover = new Uint8Array(await valid.arrayBuffer()); metadata.diagnostics.cover = 'source-image-validated'; break;
                } catch(cause) { metadata.diagnostics.cover = cause instanceof ImageValidationError ? 'invalid-image' : 'fetch-or-format-unavailable'; if (stop.aborted) break; }
            }
            if (!cover) { partial = true; metadata.diagnostics.cover ||= 'not-declared'; }
        }
        partial ||= !data.fields.Description;
    } catch(cause) { partial = true; metadata.diagnostics.page = (cause as Error)?.name === 'TimeoutError' ? 'timeout' : 'source-page-or-identity-unavailable'; }
    signal.throwIfAborted();
    await client.Request({ operation: 'queue-details-save', seq: item.seq, text, cover, extension, partial, metadata });
}
