/** Opt-in reader image extraction. No requests, URL rewriting, DOM mutation or global connector behavior changes. */
function UsableLink(value: string): string | undefined {
    const link = value?.trim();
    if (!link) return;
    try { if (['http:', 'https:'].includes(new URL(link, 'https://reader.invalid/').protocol)) return link; }
    catch { /* Malformed candidates cannot become image requests. */ }
}

/** Parse URL tokens before descriptors: commas inside query values are part of the URL, not blindly split. */
function FromSourceSet(input: string): string | undefined {
    const candidates: { link: string; size: number; unit: string }[] = [];
    let cursor = 0;
    while (cursor < input.length) {
        while (cursor < input.length && /[\s,]/.test(input[cursor])) cursor++;
        const start = cursor;
        while (cursor < input.length && !/\s/.test(input[cursor])) cursor++;
        const token = input.slice(start, cursor);
        const separated = token.endsWith(',');
        const link = UsableLink(token.replace(/,+$/, ''));
        const descriptorStart = cursor;
        if (!separated) while (cursor < input.length && input[cursor] !== ',') cursor++;
        const descriptor = separated ? '' : input.slice(descriptorStart, cursor).trim();
        const match = descriptor ? /^(?:(\d+)w|((?:\d+(?:\.\d+)?|\.\d+))x)$/.exec(descriptor) : null;
        if (link && (!descriptor || match)) {
            const unit = match?.[1] ? 'w' : 'x';
            const size = match ? Number(match[1] ?? match[2]) : 1;
            if (Number.isFinite(size) && size > 0) candidates.push({ link, size, unit });
        }
        if (!separated) cursor++;
    }
    if (!candidates.length || candidates.some(candidate => candidate.unit !== candidates[0].unit)) return;
    return candidates.reduce((best, candidate) => candidate.size > best.size ? candidate : best).link;
}

/** Prefer explicit lazy source, then a valid highest-resolution source-set candidate, then src. Preserve the selected URL verbatim. */
export function ReaderImageLink(image: HTMLImageElement): string {
    for (const attribute of ['data-src', 'data-lazy-src']) {
        const link = UsableLink(image.getAttribute(attribute));
        if (link) return link;
    }
    for (const attribute of ['data-srcset', 'srcset']) {
        const link = FromSourceSet(image.getAttribute(attribute) ?? '');
        if (link) return link;
    }
    const link = UsableLink(image.getAttribute('src'));
    if (link) return link;
    throw new Error('Reader image source is missing or unsupported');
}
