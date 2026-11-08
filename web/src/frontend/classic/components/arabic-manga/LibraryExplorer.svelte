<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { GetExplorerSearchController } from '../../../../engine/search/LocalSearchController';
    import { GetSelectionCart, CartCount, CartPartial } from '../../../../engine/archive/SelectionCartController';
    import { EngineArchiveSource, type ArchiveChapterManifest } from '../../../../engine/archive/ArchiveSource';
    import type { Manga, MangaPlugin, Chapter } from '../../../../engine/providers/MangaPlugin';
    import type { MangaReference } from '../../../../../../app/electron/src/archive/SelectiveQueueContract';
    import { ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import { Store as UI } from '../../stores/Stores.svelte';
    import ChapterPreview from './ChapterPreview.svelte';
    import View from 'carbon-icons-svelte/lib/View.svelte';
    import type { SearchSite } from '../../../../engine/search/LocalSearch';
    import SelectionCart from './SelectionCart.svelte';
    const search = GetExplorerSearchController(), cart = GetSelectionCart();
    let view = $state(search.State.Value), selections = $state(cart.State.Value), error = $state(''), busy = $state(false), showCart = $state(false);
    let manga: Manga = $state(), manifest: ArchiveChapterManifest = $state(), preview: Chapter = $state(), chapterPage = $state(0);
    let libraries: (SearchSite & { count: number; complete: boolean })[] = $state([]), chapterQuery = $state('');
    let librarySerial = 0;
    async function refreshLibraries() { const serial = ++librarySerial; try { const next = await search.Client.Libraries(search.Sites()); if (serial === librarySerial) libraries = next; } catch(cause) { error = ArchiveUIError(cause); } }
    let generation = 0; let loadedIdentity = $state('');
    $effect(() => {
        const ref = UI.explorerReference, key = ref ? JSON.stringify([ref.siteId, ref.mangaId]) : '';
        if (loadedIdentity !== key) { generation++; loadedIdentity = key; manga = undefined; manifest = undefined; preview = undefined; chapterPage = 0; chapterQuery = ''; }
    });
    const observe = value => { view = value; }, observeCart = value => { selections = value; };
    search.State.Subscribe(observe); cart.State.Subscribe(observeCart);
    onMount(() => { void search.Initialize().then(() => search.Query({}, 0)); void refreshLibraries(); void cart.Refresh().catch(cause => error = ArchiveUIError(cause)); const channel = new BroadcastChannel('haruneko-catalog'); channel.onmessage = () => { void refreshLibraries(); }; return () => channel.close(); });
    onDestroy(() => { generation++; librarySerial++; search.State.Unsubscribe(observe); cart.State.Unsubscribe(observeCart); });
    function reference(row): MangaReference { return { siteId: row.siteId, mangaId: row.mangaId, title: row.title, siteName: search.Sites().find(site => site.id === row.siteId)?.title ?? row.siteId }; }
    async function action(work: () => Promise<void>) { busy = true; error = ''; try { await work(); } catch(cause) { error = ArchiveUIError(cause); } finally { busy = false; } }
    async function open(ref: MangaReference) {
        if (busy) return; const token = ++generation; manga = undefined; manifest = undefined; preview = undefined; chapterPage = 0; chapterQuery = '';
        loadedIdentity = JSON.stringify([ref.siteId, ref.mangaId]); UI.explorerReference = ref;
        await action(async () => {
            const site = HakuNeko.PluginController.WebsitePlugins.find(site => site.Identifier === ref.siteId) as MangaPlugin;
            if (!site?.CreateEntry) throw new Error('Connector unavailable');
            const current = site.CreateEntry(ref.mangaId, ref.title), data = await new EngineArchiveSource(site).Chapters(current, AbortSignal.timeout(60000));
            if (token !== generation) return; manga = current; manifest = data;
            const existing = cart.Find(ref);
            if (existing && data.chapters.length) await cart.Save(ref, { ...existing, direction: existing.direction ?? (data.order === 'unknown' ? undefined : data.order), chapters: data.chapters.map(chapter => ({ id: chapter.id, title: chapter.title })) });
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
        await action(() => value && !cart.Find(ref) && manifest && UI.explorerReference?.siteId === ref.siteId && UI.explorerReference?.mangaId === ref.mangaId
            ? cart.Save(ref, { mode: 'all', ids: [], order: 'source', direction: manifest.order === 'unknown' ? undefined : manifest.order, chapters: manifest.chapters.map(chapter => ({ id: chapter.id, title: chapter.title })) })
            : cart.Select(ref, value));
    }
    let filteredChapters = $derived(manifest?.chapters.filter(chapter => chapter.title.toLocaleLowerCase().includes(chapterQuery.trim().toLocaleLowerCase())) ?? []);
</script>
<section data-testid="library-explorer">
    <header class="toolbar"><h2>Library Explorer</h2><div><button onclick={() => showCart = !showCart} aria-expanded={showCart}>Selection Cart ({selections.items.length})</button><button class="primary" disabled={busy || !selections.items.length} onclick={() => action(() => cart.Transfer())}>Add Selected to Downloads</button></div></header>
    {#if error || view.error}<p role="alert">{error || view.error}</p>{/if}{#if selections.message}<p role="status">{selections.message}</p>{/if}
    {#if showCart}<div class="cart-panel"><SelectionCart onopen={ref => { showCart = false; void open(ref); }} /></div>{/if}
    <div class="panes">
        <section class="pane mangas" aria-label="Media List"><div class="pane-head"><h3>Media List</h3>
            <label class="sr-only" for="explorer-site">Site</label><select id="explorer-site" disabled={busy} value={view.preference.siteId} onchange={event => { generation++; UI.explorerReference = undefined; manga = undefined; manifest = undefined; preview = undefined; search.Query({ siteId: event.currentTarget.value, page: 1 }); }}><option value="">Choose a saved library</option>{#each libraries as site (site.id)}<option value={site.id}>{site.title}</option>{/each}</select>
            <label class="sr-only" for="explorer-search">Search this library</label><input id="explorer-search" type="search" placeholder="Search this library…" value={view.preference.query} oninput={event => search.Query({ query: event.currentTarget.value, page: 1 })} />
            <details class="options"><summary>Options</summary><label><input type="checkbox" checked={view.preference.fuzzy} onchange={event => search.Query({ fuzzy: event.currentTarget.checked, page: 1 })} />Approximate title matching</label></details>
        </div><div class="rows">
            {#if !libraries.length}<p class="empty">No saved libraries. Update a site in Sites.</p>{:else if !view.preference.siteId}<p class="empty">Choose a library.</p>{/if}
            {#each view.result?.groups ?? [] as group (group.site.id)}{#each group.rows as row (row.mangaId)}{@const ref = reference(row)}{@const item = selections.items.find(item => item.siteId === ref.siteId && item.mangaId === ref.mangaId)}<article class:active={UI.explorerReference?.siteId === ref.siteId && UI.explorerReference?.mangaId === ref.mangaId}><input aria-label={`Select ${row.title}`} type="checkbox" checked={!!item} indeterminate={!!item && CartPartial(item)} disabled={busy} onchange={event => { const next = event.currentTarget.checked; event.currentTarget.checked = !!item; void selectManga(ref, next); }} /><button class="title" dir="auto" title={row.title} disabled={busy} onclick={() => open(ref)}>{row.title}</button>{#if item}<small>{CartCount(item)}</small>{/if}</article>{/each}{/each}
        </div><footer><span title={libraries.find(site => site.id === view.preference.siteId)?.complete ? 'Source coverage verified' : 'Source coverage unconfirmed; saved titles remain browsable'}>{view.status === 'searching' ? 'Searching…' : `${view.result?.total ?? 0} titles`}</span><button aria-label="Previous manga page" disabled={!view.result || view.preference.page <= 1} onclick={() => search.Query({ page: view.preference.page - 1 })}>‹</button><span>{view.preference.page}</span><button aria-label="Next manga page" disabled={!view.result || view.preference.page * 25 >= view.result.total} onclick={() => search.Query({ page: view.preference.page + 1 })}>›</button></footer></section>
        <section class="pane chapters" aria-label="Item List"><div class="pane-head"><h3>Item List</h3><p class="manga-name" dir="auto" title={UI.explorerReference?.title}>{UI.explorerReference?.title ?? 'Choose a manga'}</p><input aria-label="Search chapters" type="search" placeholder="Search chapters…" value={chapterQuery} oninput={event => { chapterQuery = event.currentTarget.value; chapterPage = 0; }} />
            <div class="selection-actions"><button disabled={busy || !manifest?.chapters.length} onclick={() => action(() => cart.Save(UI.explorerReference, { mode: 'all', ids: [], order: selected?.order ?? 'source', direction: selected?.direction ?? (manifest.order === 'unknown' ? undefined : manifest.order), chapters: manifest.chapters.map(chapter => ({ id: chapter.id, title: chapter.title })) }))}>Select All</button><button disabled={busy || !selected} onclick={() => action(() => cart.Select(UI.explorerReference, false))}>Clear Selection</button></div>
        </div><div class="rows">{#if busy}<p class="empty" role="status">Loading / saving…</p>{/if}{#if UI.explorerReference && !manifest}<button disabled={busy} onclick={() => open(UI.explorerReference)}>Load chapters</button>{/if}
        {#each filteredChapters.slice(chapterPage * 100, chapterPage * 100 + 100) as chapter (chapter.id)}<article class:active={preview?.Identifier === chapter.id}><input aria-label={`Select ${chapter.title}`} type="checkbox" checked={!!checked(chapter.id)} disabled={busy} onchange={event => { const next = event.currentTarget.checked; event.currentTarget.checked = !!checked(chapter.id); void selectChapter(chapter.id, next); }} /><span dir="auto" title={chapter.title}>{chapter.title}</span><button class="eye" title="Preview chapter" aria-label={`Preview ${chapter.title}`} disabled={busy} onclick={() => preview = manga.Entries.Value.find(item => item.Identifier === chapter.id)}><View size={18} /></button></article>{/each}
        </div><footer><span>{manifest?.chapters.length ?? 0} chapters</span><button aria-label="Previous chapter page" disabled={chapterPage === 0} onclick={() => chapterPage--}>‹</button><span>{chapterPage + 1}</span><button aria-label="Next chapter page" disabled={(chapterPage + 1) * 100 >= filteredChapters.length} onclick={() => chapterPage++}>›</button></footer></section>
        <section class="pane preview" aria-label="Chapter Preview"><div class="pane-head"><h3>Chapter Preview</h3><p class="manga-name" dir="auto">{preview?.Title ?? 'Choose a chapter to preview'}</p></div>{#if preview}{#key preview}<ChapterPreview chapter={preview} />{/key}{:else}<div class="preview-empty"><View size={32} /><p>Preview a chapter with the eye icon.</p></div>{/if}</section>
    </div>
</section>
<style>
    section[data-testid="library-explorer"]{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}.toolbar,.toolbar>div,footer,.selection-actions{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}.toolbar{justify-content:space-between;margin:.6rem 0}h2{font-size:1.05rem}h3{font-size:.95rem;font-weight:600;margin:0 0 .6rem}.panes{display:grid;grid-template-columns:minmax(13rem,.85fr) minmax(12rem,.75fr) minmax(20rem,1.6fr);gap:.6rem;flex:1;min-height:0}.pane{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--cds-ui-01);border:1px solid var(--cds-ui-03);border-radius:5px;overflow:hidden}.pane-head{padding:.7rem;border-bottom:1px solid var(--cds-ui-03)}.pane-head>select,.pane-head>input{display:block;width:100%;margin:.35rem 0}.rows{overflow:auto;flex:1;min-height:0}article{display:flex;align-items:center;gap:.4rem;padding:.3rem .5rem;border-bottom:1px solid var(--cds-ui-03);min-height:2.15rem}article.active{background:var(--cds-selected-ui);box-shadow:inset 3px 0 var(--cds-interactive-01)}article>input{flex:none;accent-color:var(--cds-interactive-01)}article span,.title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.title{text-align:start;border:0;background:transparent;padding:.2rem;font-size:.8rem}.manga-name{font-size:.8rem;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-height:1.2rem;margin:.4rem 0}button,input,select{background:var(--cds-field-01);color:var(--cds-text-01);border:1px solid var(--cds-ui-03);padding:.4rem;font:inherit;font-size:.8rem;border-radius:3px;min-width:0}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{border-color:var(--cds-interactive-01)}button:hover:not(:disabled){background:var(--cds-hover-ui)}small,footer,.options{color:var(--cds-text-02);font-size:.72rem}footer{padding:.4rem;border-top:1px solid var(--cds-ui-03)}footer>span:first-child{margin-right:auto}.eye{display:flex;border:0;background:transparent}.selection-actions{margin-top:.5rem}.options summary{cursor:pointer}.options label{display:flex;gap:.4rem;margin:.5rem 0}.empty,.preview-empty{padding:1rem;color:var(--cds-text-02);font-size:.85rem}.preview-empty{display:flex;flex:1;align-items:center;justify-content:center;flex-direction:column;gap:1rem}.cart-panel{max-height:55vh;overflow:auto;border:1px solid var(--cds-ui-03);padding:.7rem;margin-bottom:.7rem}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}[role=alert]{color:var(--cds-support-warning)}@media(max-width:1050px){.panes{grid-template-columns:minmax(11rem,1fr) minmax(11rem,1fr) minmax(16rem,1.4fr)}}@media(max-width:760px){section[data-testid="library-explorer"]{height:auto}.panes{grid-template-columns:1fr 1fr;height:auto}.mangas,.chapters{height:25rem}.preview{grid-column:1/-1;height:30rem}}@media(max-width:430px){.panes{grid-template-columns:1fr}.preview{grid-column:auto}}
</style>
