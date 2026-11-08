<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import { Button } from 'carbon-components-svelte';
    import { GetLocalSearchController } from '../../../../engine/search/LocalSearchController';
    import { StaleIndex, type SearchRow, type SearchPreference } from '../../../../engine/search/LocalSearch';
    import { MangaPlugin } from '../../../../engine/providers/MangaPlugin';
    import { IndexStateLabel } from '../../../../engine/catalog/SiteIndexController';
    import { Store as UI } from '../../stores/Stores.svelte';
    import Result from './SearchResult.svelte';
    import { GetSelectiveQueueController, QueueSupported, QueueIdentity } from '../../../../engine/archive/SelectiveQueueController';
    import SelectionCart from './SelectionCart.svelte';
    import { GetSelectionCart, CartPartial } from '../../../../engine/archive/SelectionCartController';
    const cart = GetSelectionCart();
    let cartView = $state(cart.State.Value), multi = $state(false), remove = $state<any>();
    const cartObserver = value => { cartView = value; };
    cart.State.Subscribe(cartObserver); onDestroy(() => cart.State.Unsubscribe(cartObserver));
    onMount(() => { void cart.Refresh().catch(error => queue.Error(error)); });
    let showSelections = $state(false);
    $effect(() => { if (UI.hubSection === 'selections') showSelections = true; });

    const controller = GetLocalSearchController();
    const queue = GetSelectiveQueueController();
    let queueView = $state(queue.State.Value);
    const queueObserver = value => { queueView = value; };
    queue.State.Subscribe(queueObserver);
    const reference = (row: SearchRow) => ({ siteId: row.siteId, mangaId: row.mangaId, title: row.title, siteName: controller.Sites().find(site => site.id === row.siteId)?.title ?? row.siteId });
    async function queueAction(action: () => Promise<void>) { try { await action(); } catch(error) { queue.Error(error); } }
    let cartCount = $derived(cartView.items.length);
    $effect(() => { cartCount; if (view.result && QueueSupported()) void queueAction(() => queue.Flags(view.result!.groups.flatMap(group => group.rows.map(reference)))); });
    let view = $state(controller.State.Value);
    let loaded = $state(false), opening = $state(false), openingError = $state('');
    let panel: HTMLDivElement = $state();
    let scrollTimer: ReturnType<typeof setTimeout>;
    let openToken = 0;
    let lastScroll = controller.State.Value.preference.scroll;
    const observe = value => { view = value; };
    controller.State.Subscribe(observe);
    onMount(() => { void controller.Initialize().then(async () => {
        loaded = true;
        if (view.preference.query.trim()) controller.Query({}, 0);
        await tick(); if (panel) panel.scrollTop = view.preference.scroll;
    }); });
    onMount(() => { if (QueueSupported()) void queueAction(() => queue.Refresh()); });
    onDestroy(() => { ++openToken; clearTimeout(scrollTimer); controller.SetScroll(lastScroll); controller.State.Unsubscribe(observe); queue.State.Unsubscribe(queueObserver); });
    $effect(() => { if (view.status === 'ready' && panel) { panel.scrollTop = view.preference.scroll; lastScroll = view.preference.scroll; } });
    function change(value: Partial<SearchPreference>) {
        ++openToken; opening = false; openingError = ''; lastScroll = 0;
        controller.Query({ ...value, page: value.page ?? 1, scroll: 0, active: true });
    }
    async function open(row: SearchRow) {
        const token = ++openToken; opening = true; openingError = '';
        try {
            const site = HakuNeko.PluginController.WebsitePlugins.find(plugin => plugin.Identifier === row.siteId);
            if (!(site instanceof MangaPlugin)) throw new Error('source-unavailable');
            const current = await controller.Client.Find(row.siteId, row.mangaId);
            if (token !== openToken) return;
            if (!current) throw new Error('entry-unavailable');
            controller.SetScroll(lastScroll); await controller.Flush().catch(() => {});
            if (token !== openToken) return;
            UI.selectedPlugin = site; UI.selectedMedia = site.CreateEntry(current.id, current.title); UI.selectedItem = undefined; UI.page = 'media';
        } catch { if (token === openToken) openingError = 'Cannot open this manga: the connector or saved reference is unavailable. Your search is preserved; source access errors appear in the original Media List.'; }
        finally { if (token === openToken) opening = false; }
    }
</script>
<section aria-labelledby="shared-search-title" data-testid="shared-search">
    <h2 id="shared-search-title">Search saved catalogs</h2>
    {#if QueueSupported()}
        <label class="multi"><input type="checkbox" bind:checked={multi} />Multi-select</label>
        <p data-testid="selection-total">Selected: {queueView.summary?.selected ?? 0} • In downloads: {queueView.summary?.queued ?? 0}</p>
        <Button kind="ghost" size="small" aria-expanded={showSelections} onclick={() => showSelections = !showSelections}>Saved selections ({queueView.summary?.selected ?? 0})</Button>
        <Button kind="secondary" onclick={() => queueAction(() => cart.Transfer())}>Add Selected to Downloads</Button>
        {#if queueView.message}<p role="status">{queueView.message}</p>{/if}
        {#if queueView.error}<p role="alert">{queueView.error}</p>{/if}
    {:else}<p>Selections and downloads require Electron. Local search is available.</p>{/if}
    {#if remove}<p role="alert">Remove this manga and its chapter selection?</p><button onclick={() => queueAction(async () => { await cart.Select(remove, false, true); remove = undefined; })}>Confirm removal</button><button onclick={() => remove = undefined}>Keep selection</button>{/if}
    <div class="filters">
        <label>Manga title<input data-testid="shared-search-query" type="search" maxlength="256" value={view.preference.query} disabled={!loaded} oninput={event => change({ query: event.currentTarget.value })} placeholder="Search an English or Arabic title" /></label>
        <label>Source<select data-testid="shared-search-site" value={view.preference.siteId} disabled={!loaded} onchange={event => change({ siteId: event.currentTarget.value })}>
            <option value="">All Arabic sources</option>
            {#each controller.Sites() as site (site.id)}<option value={site.id}>{site.title}</option>{/each}
        </select></label>

    </div>
    <details class="advanced"><summary>Advanced search</summary>
        <label class="fuzzy" title="Allow one or two spelling edits; no alternate titles are invented."><input data-testid="shared-search-fuzzy" type="checkbox" checked={view.preference.fuzzy} disabled={!loaded} onchange={event => change({ fuzzy: event.currentTarget.checked })} />Approximate title matching</label>
    </details>
    {#if showSelections}<div class="selection-panel"><SelectionCart /></div>{/if}
    {#if view.status === 'searching'}<p role="status">Searching local catalogs…</p>{/if}
    {#if view.error}<p role="alert">{view.error}</p><Button kind="secondary" onclick={async () => { await controller.Initialize(); controller.Query({}, 0); }}>Retry local search</Button>{/if}
    {#if openingError}<p role="alert">{openingError}</p>{/if}
    {#if view.status === 'idle'}<p>Enter a title to search your saved libraries. Use Sites to update a single source.</p>{/if}
    {#if view.result}
        <p role="status" data-testid="shared-search-total">{view.result.total} matches · Page {view.result.page} of {Math.max(1, Math.ceil(view.result.total / view.result.pageSize))}</p>
        <div class="results" bind:this={panel} data-testid="shared-search-scroll" onscroll={event => { if (view.status !== 'ready' || !event.currentTarget.isConnected) return; lastScroll = event.currentTarget.scrollTop; clearTimeout(scrollTimer); const value = lastScroll; scrollTimer = setTimeout(() => controller.SetScroll(value), 100); }}>
            {#each view.result.groups.filter(group => group.count > 0) as group (group.site.id)}
                <section class="group" data-testid="shared-search-group" data-source-id={group.site.id}>
                    <header><h3 dir="auto">{group.site.title} — {group.count} matches</h3>
                        <p>Catalog: {IndexStateLabel[group.metadata.state]} • Last saved update: {group.metadata.lastSuccess ? new Date(group.metadata.lastSuccess).toLocaleString() : 'Not recorded'}</p>
                        {#if StaleIndex(group.metadata)}<p class="warning">Cached library: last successful update is old, unknown or needs review.</p>{/if}
                        {#if group.metadata.coverage.state !== 'complete'}<p class="warning">Unconfirmed coverage: {group.metadata.coverage.state}</p>{/if}
                        <details><summary>Catalog details</summary><p>Coverage details: {group.metadata.coverage.evidence} — This does not certify image downloads or chapter completeness.</p></details>
                    </header>
                    {#each group.rows as row (JSON.stringify([row.siteId, row.mangaId]))}<Result {row} {multi} disabled={opening} onopen={open} queueSupported={QueueSupported()} selected={cartView.items.some(item => QueueIdentity(item) === QueueIdentity(row))} partial={cartView.items.some(item => QueueIdentity(item) === QueueIdentity(row) && CartPartial(item))} queued={!!queueView.queued[QueueIdentity(row)]} onselect={(item, selected) => { if (!selected) remove = reference(item); else void queueAction(() => cart.Select(reference(item), true)); }} onadd={item => queueAction(() => queue.Add(reference(item)))} />{/each}
                    {#if !group.rows.length}<small>More results from this source are on other pages.</small>{/if}
                </section>
            {/each}
            {#if !view.result.total}<p data-testid="shared-search-empty">No matches in your saved catalogs. No site requests were made.</p>{/if}
        </div>
        <div class="pages">
            <Button kind="secondary" size="small" disabled={view.result.page <= 1} onclick={() => change({ page: view.result!.page - 1 })}>Previous</Button>
            <span>{view.result.page}</span>
            <Button kind="secondary" size="small" disabled={view.result.page * view.result.pageSize >= view.result.total} onclick={() => change({ page: view.result!.page + 1 })}>Next</Button>
        </div>
    {/if}
</section>
<style>
    h2 { font-size: 1.15rem; margin: 1rem 0; } p { line-height: 1.6; margin: .65rem 0; }
    .filters { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; }
    label { display: grid; gap: .5rem; flex: 1 1 15rem; } input, select { background: var(--cds-field-01); color: var(--cds-text-01); border: 1px solid var(--cds-ui-03); font: inherit; padding: .55rem; width: 100%; min-width: 0; }
    label.fuzzy { display: flex; align-items: center; } .fuzzy input { width: auto; }
    .results { max-height: 52vh; overflow-y: auto; overflow-anchor: none; margin: 1rem 0; }
    .group { background: var(--cds-ui-01); margin: 1rem 0; } header { padding: .55rem 1rem; border-bottom: 1px solid var(--cds-ui-03); } header h3 { font-size: 1.1rem; }
    header p, small { font-size: .8rem; } .warning { color: var(--cds-support-warning); } .pages { display: flex; align-items: center; justify-content: center; gap: 1rem; }
    .advanced { margin:.6rem 0; font-size:.8rem; } summary { cursor:pointer; color:var(--cds-text-02); } .selection-panel { border:1px solid var(--cds-ui-03); border-radius:5px; padding:.75rem; margin:.75rem 0; }
</style>
