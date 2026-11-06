import type { Chapter, Page } from './providers/MangaPlugin';
import { Priority } from './taskpool/DeferredTask';
export interface ImageDiagnosticReport {
    version: 1; connector: string; chapter: string; imagePosition: number; observedPages: number | null;
    extraction: 'not-started' | 'succeeded' | 'failed'; sourceHost: string | null; responseHost: string | null;
    httpStatus: number | null; contentType: string | null; signature: string | null; bytes: number | null;
    width: number | null; height: number | null;
    stage: 'extraction' | 'fetch' | 'validation' | 'complete' | 'cancelled'; error: 'extraction-failed' | 'fetch-failed' | 'access-restricted' | 'invalid-image' | 'cancelled' | null;
}
function Label(value: unknown): string {
    return String(value ?? '').slice(0, 256).replace(/[\u0000-\u001f]/g, ' ').replace(/https?:\/\/\S+/gi, '[source]')
        .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*/g, '[path]').replace(/\b(cookie|authorization|token|secret|password)\s*[:=].*/gi, '$1=[redacted]');
}
function Host(value: string): string | null { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.hostname : null; } catch { return null; } }
const pages = new WeakMap<Page, ImageDiagnosticReport>();
const requests = new WeakMap<Request, ImageDiagnosticReport>();
export function PageDiagnostic(page: Page): ImageDiagnosticReport | undefined { return pages.get(page); }
export function AttachDiagnosticRequest(page: Page, request: Request): () => void {
    const report = pages.get(page); if (report) requests.set(request, report);
    return () => requests.delete(request);
}
export function RecordDiagnosticResponse(request: Request, response: Response): void {
    const report = requests.get(request);
    if (!report) return;
    report.httpStatus = response.status;
    const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    report.contentType = mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime.slice(0, 128) : null;
    report.responseHost = Host(response.url);
}
export async function RecordDiagnosticBlob(report: ImageDiagnosticReport, blob: Blob): Promise<void> {
    report.bytes = blob.size; report.stage = 'validation';
    const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    report.signature = bytes[0] === 0x89 && text.slice(1, 4) === 'PNG' ? 'png'
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpeg'
            : /^GIF8[79]a/.test(text) ? 'gif'
                : text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP' ? 'webp'
                    : text.slice(4, 8) === 'ftyp' && /avif|avis/.test(text.slice(8)) ? 'avif'
                        : /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(text) ? 'html'
                            : /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text) ? 'svg' : 'unknown';
}
/** Explicit single-image probe. Reports contain no URLs, headers, raw errors, cookies or response bodies. */
export async function DiagnoseChapterImage(chapter: Chapter, position: number, signal: AbortSignal): Promise<ImageDiagnosticReport> {
    const report: ImageDiagnosticReport = { version: 1, connector: Label(chapter.Parent.Parent.Title), chapter: Label(chapter.Title), imagePosition: position,
        observedPages: null, extraction: 'not-started', sourceHost: null, responseHost: null, httpStatus: null, contentType: null, signature: null, bytes: null,
        width: null, height: null, stage: 'extraction', error: null };
    let probe: Page;
    try {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(position) || position < 1) throw new Error('Invalid image position');
        await chapter.Update(); signal.throwIfAborted();
        report.observedPages = chapter.Entries.Value.length;
        const page = chapter.Entries.Value[position - 1];
        if (!page) throw new Error('Image position unavailable');
        probe = page.CreateDiagnosticCopy();
        report.sourceHost = Host(probe.Link.href);
        report.extraction = 'succeeded'; report.stage = 'fetch';
        pages.set(probe, report);
        await probe.Fetch(Priority.High, signal);
        signal.throwIfAborted(); report.stage = 'complete';
    } catch {
        if (signal.aborted) { report.stage = 'cancelled'; report.error = 'cancelled'; }
        else if (report.stage === 'extraction') { report.extraction = 'failed'; report.error = 'extraction-failed'; }
        else if ([401, 403, 429].includes(report.httpStatus)) report.error = 'access-restricted';
        else report.error = report.stage === 'validation' ? 'invalid-image' : 'fetch-failed';
    } finally { if (probe) pages.delete(probe); }
    return report;
}
