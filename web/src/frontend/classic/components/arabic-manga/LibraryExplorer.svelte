<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { GetExplorerSearchController } from '../../../../engine/search/LocalSearchController';
    import { GetSelectionCart, CartCount, CartPartial } from '../../../../engine/archive/SelectionCartController';
    import { EngineArchiveSource, type ArchiveChapterManifest } from '../../../../engine/archive/ArchiveSource';
    import type { Manga, MangaPlugin, Chapter } from '../../../../engine/providers/MangaPlugin';
    import type { MangaReference } from '../../../../../../app/electron/src/archive/SelectiveQueueContract';
    import { ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import { Store as UI } from '../../stores/Stores.svelte';
    import Viewer from '../viewer/Viewer.svelte';
    import SelectionCart from './SelectionCart.svelte';
    const search = GetExplorerSearchController(), cart = GetSelectionCart();
    let view = $state(search.State.Value), selections = $state(cart.State.Value), error = $state(''), busy = $state(false), showCart = $state(false);
    let manga: Manga = $state(), manifest: ArchiveChapterManifest = $state(), preview: Chapter = $state(), chapterPage = $state(0);
    let generation = 0; let loadedIdentity = $state('');
    $effect(() => {
        const ref = UI.explorerReference, key = ref ? JSON.stringify([ref.siteId, ref.mangaId]) : '';
        if (loadedIdentity !== key) { generation++; loadedIdentity = key; manga = undefined; manifest = undefined; preview = undefined; chapterPage = 0; }
    });
    const observe = value => { view = value; }, observeCart = value => { selections = value; };
    search.State.Subscribe(observe); cart.State.Subscribe(observeCart);
    onMount(() => { void search.Initialize().then(() => search.Query({}, 0)); void cart.Refresh().catch(cause => error = ArchiveUIError(cause)); });
    onDestroy(() => { generation++; search.State.Unsubscribe(observe); cart.State.Unsubscribe(observeCart); });
    function reference(row): MangaReference { return { siteId: row.siteId, mangaId: row.mangaId, title: row.title, siteName: search.Sites().find(site => site.id === row.siteId)?.title ?? row.siteId }; }
    async function action(work: () => Promise<void>) { busy = true; error = ''; try { await work(); } catch(cause) { error = ArchiveUIError(cause); } finally { busy = false; } }
    async function open(ref: MangaReference) {
        if (busy) return; const token = ++generation; manga = undefined; manifest = undefined; chapterPage = 0;
        loadedIdentity = JSON.stringify([ref.siteId, ref.mangaId]); UI.explorerReference = ref;
        await action(async () => {
            const site = HakuNeko.PluginController.WebsitePlugins.find(site => site.Identifier === ref.siteId) as MangaPlugin;
            if (!site?.CreateEntry) throw new Error('Connector unavailable');
            const current = site.CreateEntry(ref.mangaId, ref.title), data = await new EngineArchiveSource(site).Chapters(current, AbortSignal.timeout(60000));
            if (token !== generation) return; manga = current; manifest = data;
            const existing = cart.Find(ref);
            if (existing) await cart.Save(ref, { ...existing, direction: existing.direction ?? (data.order === 'unknown' ? undefined : data.order), chapters: data.chapters.map(chapter => ({ id: chapter.id, title: chapter.title })) });
        });
    }
    let selected = $derived(UI.explorerReference ? selections.items.find(item => item.siteId === UI.explorerReference.siteId && item.mangaId === UI.explorerReference.mangaId) : undefined);
    function checked(id: string) { return selected && (selected.mode === 'all' || selected.mode === 'except' && !selected.ids.includes(id) || selected.mode === 'selected' && selected.ids.includes(id)); }
    async function selectChapter(id: string, enabled: boolean) {
        await action(async () => {
            const previous = cart.Find(UI.explorerReference), chapters = manifest.chapters.map(chapter => ({ id: chapter.id, title: chapter.title }));
            let mode = previous?.mode ?? 'selected'; if (mode === 'all') mode = 'except';
            const ids = new Set(previous?.ids ?? []);
            if (mode === 'except' ? !enabled : enabled) ids.add(id); else ids.delete(id);
            await cart.Save(UI.explorerReference, { mode, ids: [...ids], order: previous?.order ?? 'source', direction: previous?.direction ?? (manifest.order === 'unknown' ? undefined : manifest.order), chapters });
        });
    }
    async function selectManga(ref: MangaReference, value: boolean) {
        const previous = cart.Find(ref);
        if (!value && previous) { showCart = true; error = 'Confirm removal in Selection Cart'; return; }
        await action(() => cart.Select(ref, value));
    }
</script>
<section data-testid="library-explorer">
    <header><h2>Library Explorer</h2><button onclick={() => showCart = !showCart}>Selection Cart ({selections.items.length})</button><button disabled={busy || !selections.items.length} onclick={() => action(() => cart.Transfer())}>Add Selected to Downloads</button><button onclick={() => UI.hubSection = 'queue'}>Downloads</button></header>
    {#if error || view.error}<p role="alert">{error || view.error}</p>{/if}{#if cart.State.Value.message}<p role="status">{cart.State.Value.message}</p>{/if}
    {#if showCart}<SelectionCart onopen={ref => { showCart = false; void open(ref); }} />{/if}
    {#if preview}<button onclick={() => preview = undefined}>Back to Explorer</button><div class="reader"><Viewer item={preview} isolated /></div>
    {:else}
    <div class="filters"><label>Site<select disabled={busy} value={view.preference.siteId} onchange={event => { generation++; UI.explorerReference = undefined; manga = undefined; manifest = undefined; search.Query({ siteId: event.currentTarget.value, page: 1 }); }}><option value="">Choose a site</option>{#each search.Sites() as site (site.id)}<option value={site.id}>{site.title}</option>{/each}</select></label><label>Search this library<input type="search" value={view.preference.query} oninput={event => search.Query({ query: event.currentTarget.value, page: 1 })} /></label><details><summary>Options</summary><label><input type="checkbox" checked={view.preference.fuzzy} onchange={event => search.Query({ fuzzy: event.currentTarget.checked, page: 1 })} />Approximate title matching</label></details></div>
    <div class="panes"><div class="mangas"><p>{view.status === 'searching' ? 'Searching…' : `${view.result?.total ?? 0} observed titles`}</p>
    {#each view.result?.groups ?? [] as group (group.site.id)}<small>{group.metadata.coverage.state === 'complete' ? 'Source coverage verified' : 'Coverage unconfirmed'} · {group.metadata.count} saved</small>{#each group.rows as row (row.mangaId)}{@const ref = reference(row)}{@const item = selections.items.find(item => item.siteId === ref.siteId && item.mangaId === ref.mangaId)}<article><input aria-label={`Select ${row.title}`} type="checkbox" checked={!!item} indeterminate={!!item && CartPartial(item)} disabled={busy} onchange={event => { const next = event.currentTarget.checked; event.currentTarget.checked = !!item; void selectManga(ref, next); }} /><button class="title" dir="auto" disabled={busy} onclick={() => open(ref)}>{row.title}</button>{#if item}<small>{CartCount(item)}</small>{/if}</article>{/each}{/each}
    <footer><button disabled={!view.result || view.preference.page <= 1} onclick={() => search.Query({ page: view.preference.page - 1 })}>Previous</button><span>{view.preference.page}</span><button disabled={!view.result || view.preference.page * 25 >= view.result.total} onclick={() => search.Query({ page: view.preference.page + 1 })}>Next</button></footer></div>
    <div class="chapters"><h3 dir="auto">{UI.explorerReference?.title ?? 'Choose a manga'}</h3>{#if busy}<p role="status">Loading / saving…</p>{/if}
    {#if UI.explorerReference && !manifest}<button disabled={busy} onclick={() => open(UI.explorerReference)}>Load chapters</button>{/if}
    {#if manifest}<header><span>{manifest.chapters.length} observed chapters</span><button disabled={busy} onclick={() => action(() => cart.Save(UI.explorerReference, { mode: 'all', ids: [], order: selected?.order ?? 'source', direction: selected?.direction ?? (manifest.order === 'unknown' ? undefined : manifest.order), chapters: manifest.chapters.map(chapter => ({ id: chapter.id, title: chapter.title })) }))}>Select All</button><button disabled={busy} onclick={() => action(() => cart.Save(UI.explorerReference, { mode: 'selected', ids: [], order: selected?.order ?? 'source', direction: selected?.direction ?? (manifest.order === 'unknown' ? undefined : manifest.order), chapters: manifest.chapters.map(chapter => ({ id: chapter.id, title: chapter.title })) }))}>Clear Selection</button></header>
    {#each manifest.chapters.slice(chapterPage * 100, chapterPage * 100 + 100) as chapter (chapter.id)}<article><input aria-label={`Select ${chapter.title}`} type="checkbox" checked={!!checked(chapter.id)} disabled={busy} onchange={event => { const next = event.currentTarget.checked; event.currentTarget.checked = !!checked(chapter.id); void selectChapter(chapter.id, next); }} /><span dir="auto">{chapter.title}</span><button title="Preview chapter" aria-label={`Preview ${chapter.title}`} disabled={busy} onclick={() => preview = manga.Entries.Value.find(item => item.Identifier === chapter.id)}>◉</button></article>{/each}
    <footer><button disabled={chapterPage === 0} onclick={() => chapterPage--}>Previous chapters</button><span>{chapterPage + 1}</span><button disabled={(chapterPage + 1) * 100 >= manifest.chapters.length} onclick={() => chapterPage++}>Next chapters</button></footer>{/if}
    </div></div>{/if}
</section>
<style>header,.filters,article,footer{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}header{justify-content:space-between;margin:.7rem 0}h2{font-size:1.15rem}h3{font-size:1rem}.filters{margin:1rem 0}label{display:grid;gap:.4rem}.panes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem}.mangas,.chapters{max-height:62vh;overflow-y:auto;background:var(--cds-ui-01);padding:.8rem;min-width:0}article{padding:.5rem;border-bottom:1px solid var(--cds-ui-03);flex-wrap:nowrap}article span,.title{flex:1;overflow-wrap:anywhere}.title{text-align:start;border:0;background:transparent;padding:.25rem}button,input,select{background:var(--cds-field-01);color:var(--cds-text-01);border:1px solid var(--cds-ui-03);padding:.5rem}button{cursor:pointer}small{color:var(--cds-text-02)}footer{justify-content:center;margin:.6rem}.reader{height:75vh}[role=alert]{color:var(--cds-support-warning)}@media(max-width:850px){.panes{grid-template-columns:1fr}}</style>
