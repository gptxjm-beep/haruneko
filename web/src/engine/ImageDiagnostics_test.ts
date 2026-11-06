import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnoseChapterImage, RecordDiagnosticResponse } from './ImageDiagnostics';
import { Manga, Chapter, Page, DecoratableMangaScraper, type MangaPlugin } from './providers/MangaPlugin';
import { FetchImageAjax } from './websites/decorators/Common';
import { Fetch } from './platform/FetchProvider';
import type { Priority } from './taskpool/TaskPool';
vi.mock('./platform/FetchProvider', () => ({ Fetch: vi.fn(), FetchCSS: vi.fn(), FetchWindowScript: vi.fn() }));
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const decode = vi.fn();
function Fixture() {
    class Scraper extends DecoratableMangaScraper {
        constructor() { super('fixture', 'Fixture connector', 'https://fixture.invalid'); }
        override FetchImage(page: Page, priority: Priority, signal: AbortSignal) { return FetchImageAjax.call(this, page, priority, signal); }
    }
    const scraper = new Scraper();
    const manga = new Manga(scraper, { Title: 'Fixture connector' } as MangaPlugin, 'manga', 'Manga');
    const chapter = new Chapter(scraper, manga, 'private-id?token=hidden', 'Public chapter');
    const page = new Page(scraper, chapter, new URL('https://images.invalid/private/token-path.png?signature=secret'), { Referer: 'https://fixture.invalid/chapter/?token=hidden' });
    chapter.Update = vi.fn(async () => { chapter['entries'].Value = [page]; });
    return { chapter, page };
}
beforeEach(() => {
    decode.mockReset().mockResolvedValue(undefined); vi.mocked(Fetch).mockReset();
    vi.stubGlobal('Image', class { naturalWidth = 2; naturalHeight = 200; src = ''; decode = decode; });
});
afterEach(() => vi.unstubAllGlobals());
describe('Opt-in single-image diagnostics', () => {
    it('Should report status, signature and dimensions without URLs, signed queries or raw headers', async () => {
        const f = Fixture();
        const response = new Response(png, { headers: { 'Content-Type': 'text/html; token=secret' } });
        Object.defineProperty(response, 'url', { value: 'https://redirect.invalid/path?signature=secret' });
        vi.mocked(Fetch).mockResolvedValue(response);
        const report = await DiagnoseChapterImage(f.chapter, 1, new AbortController().signal);
        expect(report).toMatchObject({ extraction: 'succeeded', sourceHost: 'images.invalid', responseHost: 'redirect.invalid', httpStatus: 200, contentType: 'text/html', signature: 'png', bytes: 8, width: 2, height: 200, stage: 'complete', error: null });
        expect(JSON.stringify(report)).not.toMatch(/https:|private|signature=|secret|token-path|Referer|Cookie/);
        expect(decode).toHaveBeenCalledOnce();
    });
    it('Should identify HTML as an invalid image without retaining response text', async () => {
        const f = Fixture(); decode.mockRejectedValue(new Error('Raw private decoder error'));
        vi.mocked(Fetch).mockResolvedValue(new Response('<html>private response</html>', { headers: { 'Content-Type': 'image/png' } }));
        const report = await DiagnoseChapterImage(f.chapter, 1, new AbortController().signal);
        expect(report).toMatchObject({ stage: 'validation', signature: 'html', error: 'invalid-image', width: null });
        expect(JSON.stringify(report)).not.toContain('private');
    });
    it('Should preserve HTTP status when the existing provider rejects access before returning a blob', async () => {
        const f = Fixture();
        vi.mocked(Fetch).mockImplementation(async request => { RecordDiagnosticResponse(request, new Response('', { status: 403 })); throw new Error('Forbidden secret URL'); });
        expect(await DiagnoseChapterImage(f.chapter, 1, new AbortController().signal)).toMatchObject({ stage: 'fetch', httpStatus: 403, error: 'access-restricted', bytes: null });
    });
    it('Should not fetch after cancellation during extraction or retain raw extraction errors', async () => {
        const f = Fixture(); const controller = new AbortController();
        f.chapter.Update = vi.fn(async () => { controller.abort(); });
        expect(await DiagnoseChapterImage(f.chapter, 1, controller.signal)).toMatchObject({ error: 'cancelled', stage: 'cancelled' });
        expect(Fetch).not.toHaveBeenCalled();
        f.chapter.Update = vi.fn(async () => { throw new Error('https://private.invalid/?token=secret'); });
        const result = await DiagnoseChapterImage(f.chapter, 1, new AbortController().signal);
        expect(result.error).toBe('extraction-failed'); expect(JSON.stringify(result)).not.toContain('secret');
    });
    it('Should leave ordinary viewer fetches outside the diagnostic report and decode them once', async () => {
        const f = Fixture(); vi.mocked(Fetch).mockResolvedValue(new Response(png, { headers: { 'Content-Type': 'image/png' } }));
        expect((await f.page.Fetch(4, new AbortController().signal)).type).toBe('image/png'); expect(decode).toHaveBeenCalledOnce();
    });
});
