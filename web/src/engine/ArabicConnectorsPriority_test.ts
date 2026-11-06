import { beforeEach, describe, expect, it, vi } from 'vitest';
import MangaTek from './websites/MangaTek';
import MangaLover from './websites/MangaLover';
import { Manga, Chapter, type MangaPlugin } from './providers/MangaPlugin';
import { FetchCSS } from './platform/FetchProvider';
import * as Madara from './websites/decorators/WordPressMadara';

vi.mock('./platform/FetchProvider', () => ({ FetchCSS: vi.fn(), Fetch: vi.fn(), FetchHTML: vi.fn(), FetchWindowScript: vi.fn() }));
function Image(attributes: Record<string, string>): HTMLImageElement {
    return { dataset: { src: attributes['data-src'], lazySrc: attributes['data-lazy-src'], srcset: attributes['data-srcset'] },
        src: attributes.src ?? '', srcset: attributes.srcset ?? '', getAttribute: (name: string) => attributes[name] ?? null } as unknown as HTMLImageElement;
}
function Fixture(scraper: MangaTek | MangaLover) {
    const site = { Identifier: scraper.Identifier, Title: scraper.Title } as MangaPlugin;
    const manga = new Manga(scraper, site, JSON.stringify({ post: 'fixture', slug: '/manga/local/' }), 'Local');
    const chapter = new Chapter(scraper, manga, '/reader/local/1/', 'Chapter 1');
    return { scraper, manga, chapter };
}
function Images(images: HTMLImageElement[]) {
    const body = { querySelector: () => null, querySelectorAll: () => images } as unknown as HTMLElement;
    vi.mocked(FetchCSS).mockImplementation(async (_request, query) => query === 'body' ? [body] : images as any);
}
beforeEach(() => vi.mocked(FetchCSS).mockReset());

describe('Arabic priority connector extraction — synthetic fixtures, not live captures', () => {
    it('Should extract later lazy pages in MangaTek instead of placeholder data after the first two', async () => {
        const f = Fixture(new MangaTek());
        Images([Image({ src: '/images/1.jpg' }), Image({ 'data-src': '/images/2.jpg', src: '/placeholder.gif' }),
            Image({ 'data-lazy-src': '/images/3.jpg', src: 'data:image/gif;base64,AA==' }), Image({ srcset: '/images/4-small.jpg 480w, /images/4.jpg 1600w', src: '/placeholder.gif' })]);
        const pages = await f.scraper.FetchPages(f.chapter);
        expect(pages.map(page => page.Link.href)).toEqual([1, 2, 3, 4].map(n => `https://mangatek.com/images/${n}.jpg`));
        expect(pages.every(page => page.Parameters.Referer === 'https://mangatek.com/reader/local/1/')).toBe(true);
    });
    it('Should turn a Madara srcset into one image URL rather than requesting the entire descriptor list', async () => {
        const f = Fixture(new MangaLover());
        Images([Image({ srcset: 'https://bleach-images.invalid/1-small.jpg 480w, https://bleach-images.invalid/1.jpg 1600w' })]);
        const pages = await f.scraper.FetchPages(f.chapter);
        expect(pages[0].Link.href).toBe('https://bleach-images.invalid/1.jpg');
    });
    it('Should preserve distinct hosts, lazy-source priority, page order and repeated page elements', async () => {
        const f = Fixture(new MangaLover());
        Images([Image({ 'data-src': ' https://abyss-images.invalid/1.jpg ', srcset: 'https://other.invalid/placeholder.jpg 2x' }),
            Image({ src: 'https://abyss-images.invalid/2.jpg' }), Image({ src: 'https://abyss-images.invalid/2.jpg' })]);
        const pages = await f.scraper.FetchPages(f.chapter);
        expect(pages.map(page => page.Link.href)).toEqual(['https://abyss-images.invalid/1.jpg', 'https://abyss-images.invalid/2.jpg', 'https://abyss-images.invalid/2.jpg']);
    });
    it('Should resolve relative lazy links against the chapter without losing valid comma-containing query values', async () => {
        const f = Fixture(new MangaLover());
        Images([Image({ 'data-srcset': 'pages/small.jpg?sample=a,b 1x, pages/full.jpg?sample=c,d 2x' })]);
        expect((await f.scraper.FetchPages(f.chapter))[0].Link.href).toBe('https://3asq.online/reader/local/1/pages/full.jpg?sample=c,d');
    });
    it('Should fail a missing page source instead of requesting chapter HTML as an image', async () => {
        const f = Fixture(new MangaTek()); Images([Image({ src: 'data:image/gif;base64,AA==' })]);
        await expect(f.scraper.FetchPages(f.chapter)).rejects.toThrow('image source');
    });
    it('Should retain all 364 AJAX chapters in supplied newest-first order, including a special and fractional chapter', async () => {
        const f = Fixture(new MangaLover());
        const ids = ['special', '299.5', ...Array.from({ length: 362 }, (_, index) => String(362 - index))];
        const anchors = ids.map(id => ({ pathname: `/manga/local/${id}/`, innerText: `Local ${id}`, querySelectorAll: () => [] })) as unknown as HTMLAnchorElement[];
        vi.mocked(FetchCSS).mockResolvedValue(anchors);
        const chapters = await f.scraper.FetchChapters(f.manga);
        expect(chapters.map(chapter => chapter.Identifier)).toEqual(ids.map(id => `/manga/local/${id}/`));
        const [request] = vi.mocked(FetchCSS).mock.calls[0];
        expect(request.method).toBe('POST'); expect(request.url).toBe('https://3asq.online/manga/local/ajax/chapters/');
        expect(request.headers.get('Referer')).toBe('https://3asq.online/');
    });
    it('Should return a 50-item response as observations without inventing missing chapter IDs from the last number', async () => {
        const f = Fixture(new MangaLover());
        vi.mocked(FetchCSS).mockResolvedValue(Array.from({ length: 50 }, (_, index) => ({ pathname: `/manga/local/${299 - index}/`, innerText: String(299 - index), querySelectorAll: () => [] })) as unknown as HTMLAnchorElement[]);
        expect(await f.scraper.FetchChapters(f.manga)).toHaveLength(50);
        expect(vi.mocked(FetchCSS)).toHaveBeenCalledOnce();
    });
    it('Should leave the default Madara extraction path unchanged for connectors that do not opt in', async () => {
        const f = Fixture(new MangaLover());
        Images([Image({ 'data-src': 'https://legacy-images.invalid/1.jpg', src: 'https://legacy-images.invalid/fallback.jpg' })]);
        const pages = await Madara.FetchPagesSinglePageCSS.call(f.scraper, f.chapter);
        expect(pages[0].Link.href).toBe('https://legacy-images.invalid/1.jpg');
    });
    it.each([
        { attrs: { 'data-src': '  ', 'data-lazy-src': '/images/fallback.jpg', src: '/placeholder.gif' } },
        { attrs: { srcset: '/invalid.jpg 0w, /also-invalid.jpg 2x 4x', src: '/images/fallback.jpg' } },
        { attrs: { 'data-src': 'javascript:alert(1)', srcset: '/one.jpg 100w, /two.jpg 2x', src: '/images/fallback.jpg' } },
    ])('Should use a safe fallback for blank, malformed or mixed source candidates: $attrs', async ({ attrs }) => {
        const f = Fixture(new MangaTek()); Images([Image(attrs)]);
        expect((await f.scraper.FetchPages(f.chapter))[0].Link.href).toBe('https://mangatek.com/images/fallback.jpg');
    });
});
