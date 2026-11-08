<script lang="ts">
    import { onMount } from 'svelte';
    import { GetSelectiveQueueController } from '../../../../engine/archive/SelectiveQueueController';
    import { EngineArchiveSource, type ArchiveChapterManifest } from '../../../../engine/archive/ArchiveSource';
    import { MangaPlugin } from '../../../../engine/providers/MangaPlugin';
    import { StorageControllerBrowser } from '../../../../engine/StorageControllerBrowser';
    import { Store } from '../../../../engine/StorageController';
    import type { QueueManga, ChapterOrder, QueueScope } from '../../../../../../app/electron/src/archive/SelectiveQueueContract';
    import { ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    let { row, running, onedit }: { row: QueueManga; running: boolean; onedit: (work: () => Promise<void>) => Promise<void> } = $props();
    const queue = GetSelectiveQueueController(), storage = new StorageControllerBrowser();
    const key = () => `arabic-chapters:${JSON.stringify([row.siteId, row.mangaId])}`;
    type Preview = ArchiveChapterManifest & { chapters: readonly (ArchiveChapterManifest['chapters'][number] & { state?: string; localState?: string })[] };
    let preview: Preview = $state(), expanded = $state(false), busy = $state(false), error = $state('');
    let generation = 0, disposed = false;
    let statusBusy = false;
    let draftOrder: ChapterOrder = $state(), supplementary: QueueScope = $state();
    let order = $derived(draftOrder ?? row.scope.order ?? 'source');
    let direction = $derived(row.scope.direction ?? (preview?.order === 'unknown' ? '' : preview?.order) ?? '');
    let visible = $derived(preview ? ((order === 'first-last' && direction === 'descending' || order === 'last-first' && direction === 'ascending') ? [...preview.chapters].reverse() : preview.chapters) : []);
    const selected = (id: string) => {
        if (row.scope.mode === 'selected') return row.scope.ids.includes(id);
        if (row.scope.mode !== 'range' || !preview) return true;
        const chronological = direction === 'descending' ? preview.chapters.toReversed() : preview.chapters;
        return chronological.slice(row.scope.from - 1, row.scope.to).some(chapter => chapter.id === id);
    };
    onMount(() => {
        const current = generation;
        void storage.LoadPersistent<Preview>(Store.Settings, key()).then(value => { if (!disposed && current === generation && value) preview = { ...value, chapters: value.chapters.map(chapter => ({ ...chapter, state: undefined, localState: undefined })) }; }).catch(() => {});
        return () => { disposed = true; generation++; };
    });
    $effect(() => {
        row.progress; row.state;
        if (expanded && row.sessionId && !busy) void refreshStates();
    });
    async function refreshStates() {
        if (statusBusy || disposed) return;
        statusBusy = true; const current = generation;
        try {
            const states = new Map<string, any>();
            for (let offset = 0; !disposed; offset += 200) {
                const page = await queue.Client.Request<any[]>({ operation: 'queue-chapters', seq: row.seq, offset });
                for (const chapter of page) states.set(chapter.id, chapter);
                if (page.length < 200) break;
            }
            if (!disposed && current === generation && preview) preview = { ...preview, chapters: preview.chapters.map(chapter => ({ ...chapter, state: states.get(chapter.id)?.state, localState: states.get(chapter.id)?.localState })) };
        } catch { /* Transient status read failures do not modify selected identities. */ }
        finally { statusBusy = false; }
    }
    async function load() {
        generation++;
        busy = true; error = '';
        try {
            if (row.sessionId) {
                const chapters = [];
                for (let offset = 0; ; offset += 200) {
                    const page = await queue.Client.Request<any[]>({ operation: 'queue-chapters', seq: row.seq, offset });
                    chapters.push(...page); if (page.length < 200) break;
                }
                const cached = await storage.LoadPersistent<Preview>(Store.Settings, key()).catch(() => undefined);
                const states = new Map(chapters.map(chapter => [chapter.id, chapter]));
                const sourcePositions = new Map(row.scope.sourceIds?.map((id, position) => [id, position]) ?? []);
                const originals = cached?.chapters ?? (sourcePositions.size ? chapters.toSorted((a, b) => sourcePositions.get(a.id) - sourcePositions.get(b.id)) : chapters);
                const known = new Set(originals.map(chapter => chapter.id));
                const combined = [...originals, ...chapters.filter(chapter => !known.has(chapter.id))];
                preview = { chapters: combined.map(chapter => ({ ...chapter, state: states.get(chapter.id)?.state, localState: states.get(chapter.id)?.localState })), order: cached?.order ?? 'unknown', orderEvidence: cached?.orderEvidence ?? 'Saved execution sequence; original chronological direction is not asserted', coverage: { state: 'unknown', evidence: 'Saved manifest and cached source references; no new source listing' } };
            } else {
                const site = HakuNeko.PluginController.WebsitePlugins.find(plugin => plugin.Identifier === row.siteId);
                if (!(site instanceof MangaPlugin)) throw new Error('Original connector is unavailable');
                const signal = AbortSignal.timeout(60000);
                preview = await Promise.race([new EngineArchiveSource(site).Chapters(site.CreateEntry(row.mangaId, row.title), signal), new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Chapter listing timed out; no download has started')), { once: true }))]);
                await queue.Client.Request({ operation: 'queue-observation', seq: row.seq, available: preview.chapters.length });
            }
            if (row.historyCount) {
                const disk = new Map((await queue.Audit(row.seq)).map(item => [item.id, item.localState]));
                preview = { ...preview, chapters: preview.chapters.map(chapter => ({ ...chapter, localState: disk.get(chapter.id) })) };
            }
            await storage.SavePersistent($state.snapshot(preview), Store.Settings, key());
        } catch { error = 'Cannot load chapter references. Existing selections are safe; retry after the connector request has settled.'; }
        finally { busy = false; }
    }
    async function change(scope: QueueScope) {
        generation++;
        busy = true; error = '';
        try {
            const sourceIds = preview?.chapters.map(chapter => chapter.id);
            if ((scope.order ?? 'source') !== 'source' && !(scope.direction ?? (preview?.order === 'unknown' ? undefined : preview?.order))) throw new Error('Choose which end the source shows first before applying chronological order');
            await onedit(() => queue.Edit(row.seq, 'up', { ...scope, order: scope.order ?? 'source', direction: scope.direction ?? (preview?.order === 'unknown' ? undefined : preview?.order), sourceIds: sourceIds ?? row.scope.sourceIds }));
            // Retain original source positions in the cache; order changes never rewrite this snapshot.
            draftOrder = undefined; supplementary = undefined;
        } catch(cause) { error = ArchiveUIError(cause); draftOrder = undefined; if (row.sessionId && /manifest|registered/i.test(error)) supplementary = scope; }
        finally { busy = false; }
    }
    async function toggle(id: string, checked: boolean) {
        const ids = new Set(row.scope.mode === 'selected' ? row.scope.ids : preview.chapters.map(chapter => chapter.id));
        checked ? ids.add(id) : ids.delete(id);
        await change({ ...row.scope, mode: 'selected', ids: [...ids], order });
    }
    async function chooseOrder(value: ChapterOrder) {
        if (!preview) await load();
        if (value !== 'source' && !direction) { draftOrder = value; error = 'Order not applied yet. Choose which end the source shows first below; the preview and downloads will then use the same order.'; expanded = true; return; }
        await change({ ...row.scope, order: value });
    }
</script>
<div class="chapter-policy">
    <label>Chapter Order <select disabled={running || busy} value={order} onchange={event => chooseOrder(event.currentTarget.value as ChapterOrder)}>
        <option value="source">Source Order</option><option value="first-last">First → Last</option><option value="last-first">Last → First</option>
    </select></label>
    {#if row.scope.mode === 'selected' && !row.scope.ids.length}<p>No chapters selected. This item will not start; its saved files are retained.</p>{/if}
    {#if row.sessionId && !row.scope.order}<button disabled={running || busy || !preview} onclick={() => change({ ...row.scope, order: 'source' })}>Apply Source Order to saved task</button>{/if}
    <button disabled={busy || running && !row.sessionId} aria-expanded={expanded} onclick={async () => { expanded = !expanded; if (expanded) await load(); }}>Chapters ({preview?.chapters.length ?? row.progress?.registered ?? 'load'})</button>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if supplementary}<div role="alert">The saved manifest cannot grow. Create a linked supplementary task for this selection? Existing files and the cumulative budget are retained.<button disabled={busy || running} onclick={() => onedit(() => queue.Supplement(row.seq, { ...supplementary, order, sourceIds: preview?.chapters.map(chapter => chapter.id), direction: direction as 'ascending' | 'descending' || undefined }))}>Confirm supplementary task</button><button onclick={() => supplementary = undefined}>Keep saved task</button></div>{/if}
    {#if expanded}
        <div class="chapter-panel" data-testid="queue-chapters">
            <p>{row.sessionId ? 'Saved manifest only. This does not discover new chapters.' : 'Source chapter references only; no image download.'}</p>
            <p>{preview?.order === 'unknown' ? 'Chronology unproven. Source Order accepts the source sequence without claiming oldest-first order.' : `Connector direction: ${preview?.order ?? 'not loaded'}`}</p>
            {#if preview?.order === 'unknown'}<label>Which end does the source show first? ({preview.chapters[0]?.title} → {preview.chapters.at(-1)?.title})<select value={row.scope.direction ?? ''} disabled={busy || running} onchange={event => change({ ...row.scope, order, direction: (event.currentTarget.value || undefined) as 'ascending' | 'descending' })}><option value="">Choose to apply chronological order</option><option value="ascending">Oldest first</option><option value="descending">Newest first</option></select></label>{/if}
            <button disabled={!preview || busy || running} onclick={() => change({ mode: 'all', order, direction: row.scope.direction })}>Select All</button>
            <button disabled={!preview || busy || running} onclick={() => change({ mode: 'selected', ids: [], order, direction: row.scope.direction })}>Clear Selection</button>
            <div class="chapter-list">
                {#each visible as chapter, index (JSON.stringify([chapter.id, index]))}
                    <label class:chosen={selected(chapter.id)} class:healthy={chapter.localState === 'healthy'} class:review={chapter.state === 'review' || chapter.state === 'failed'}>
                        <input type="checkbox" checked={selected(chapter.id)} disabled={busy || running} onchange={event => toggle(chapter.id, event.currentTarget.checked)} /><span dir="auto">{chapter.title}</span><small>{chapter.localState === 'healthy' ? 'Verified' : chapter.localState && chapter.localState !== 'not-written' ? chapter.localState : chapter.state === 'healthy' ? 'Awaiting file check' : chapter.state ?? 'Not registered'}</small>
                    </label>
                {/each}
            </div>
        </div>
    {/if}
</div>
<style>
    .chapter-policy { margin:.7rem 0; } label { font-size:.8rem; } select,button { background:var(--cds-field-01); color:var(--cds-text-01); padding:.4rem; border:1px solid var(--cds-ui-03); margin:.3rem; } .chapter-panel { padding:.65rem; border:1px solid var(--cds-ui-03); background:var(--cds-ui-background); } .chapter-list { max-height:20rem; overflow:auto; } .chapter-list label { display:flex; align-items:center; gap:.5rem; padding:.4rem; border-bottom:1px solid var(--cds-ui-03); } span { flex:1; overflow-wrap:anywhere; } small { color:var(--cds-text-02); } .chosen { border-inline-start:3px solid var(--cds-interactive-01); } .healthy { color:var(--cds-support-success); } .review,[role=alert] { color:var(--cds-support-warning); } p { font-size:.8rem; margin:.5rem 0; }
</style>
