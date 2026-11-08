export interface MangaMetadata {
    schema: 1; title: string; sourceName: string; sourceURL?: string; fields: Record<string, string>; diagnostics?: Record<string, string>; cover?: string;
}
const Escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
export function ValidateMangaMetadata(value: MangaMetadata): MangaMetadata {
    if (!value || value.schema !== 1 || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 4096 || !value.fields || Array.isArray(value.fields)
        || Object.keys(value.fields).length > 50 || Object.entries(value.fields).some(([key, field]) => key.length > 100 || typeof field !== 'string' || field.length > 20000)) throw new Error('Invalid manga information');
    if (value.cover && !/^(?:cover|cover-[a-f0-9-]+)\.(png|jpg|webp|gif|bmp|avif)$/.test(value.cover)) throw new Error('Invalid cover filename');
    return value;
}
/** Offline display generated solely from editable metadata; no remote resources or scripts. */
export function RenderMangaMetadata(input: MangaMetadata, assetPrefix = ''): string {
    const metadata = ValidateMangaMetadata(input), fields = metadata.fields;
    const cover = /^(?:cover|cover-[a-f0-9-]+)\.(png|jpg|webp|gif|bmp|avif)$/.test(metadata.cover ?? '') ? `<img src="${Escape(assetPrefix + metadata.cover)}" alt="Manga cover">` : '<div class="placeholder">No cover</div>';
    let link = ''; try { const url = new URL(metadata.sourceURL ?? ''); if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search) link = `<a rel="noreferrer" href="${Escape(url.href)}">Open original manga</a>`; } catch { /* No fabricated source URL. */ }
    const facts = ['Type', 'Status', 'Author', 'Artist', 'Genres', 'Alternate titles'].filter(key => fields[key]).map(key => `<div><dt>${key}</dt><dd dir="auto">${Escape(fields[key])}</dd></div>`).join('');
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'"><title>${Escape(metadata.title)}</title><style>body{font:16px/1.6 system-ui;background:#10131a;color:#e9edf5;margin:0;padding:clamp(1rem,4vw,3rem)}main{max-width:1100px;margin:auto}header{display:grid;grid-template-columns:minmax(180px,300px) minmax(0,1fr);gap:2rem;align-items:start}img,.placeholder{width:100%;max-height:480px;object-fit:contain;border-radius:12px;background:#1d2330}.placeholder{height:360px;display:grid;place-items:center;color:#9ca9bc}h1{font-size:clamp(1.7rem,4vw,2.8rem);line-height:1.2}section{padding:1.5rem;background:#1b2130;border:1px solid #2c3546;border-radius:12px;margin:1.5rem 0}p{white-space:pre-wrap;overflow-wrap:anywhere}small,dt{color:#aebbd0}a{color:#9bc8ff}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}dd{margin:0;overflow-wrap:anywhere}@media(max-width:620px){header{grid-template-columns:1fr}img,.placeholder{max-width:300px;margin:auto}dl{grid-template-columns:1fr}}</style><main><header>${cover}<div><small dir="auto">${Escape(metadata.sourceName)}</small><h1 dir="auto">${Escape(metadata.title)}</h1><dl>${facts}</dl>${link}</div></header><section><h2>Story</h2><p dir="auto">${Escape(fields.Description || 'Description unavailable')}</p></section></main></html>`;
}
