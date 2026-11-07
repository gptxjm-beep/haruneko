<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { Button } from 'carbon-components-svelte';
    import { FilterHubSites, IsMultilingual, OpenPlugin, SiteObservation, type SiteScope } from '../../models/PluginPresentation';
    import { Store as UI } from '../../stores/Stores.svelte';
    import { GetSiteIndexController, ArabicCatalogSources, IndexStateLabel, IndexJobStateLabel, IndexErrorLabel } from '../../../../engine/catalog/SiteIndexController';
    import SharedSearch from './SharedSearch.svelte';
    import PersonalQueue from './PersonalQueue.svelte';
    import { GetLocalSearchController } from '../../../../engine/search/LocalSearchController';
    import PluginOrder from './PluginOrder.svelte';

    let heading: HTMLHeadingElement;
    async function chooseSection(section: 'sites' | 'search' | 'selections' | 'queue') { UI.hubSection = section; await searcher.Initialize(); searcher.SetActive(section === 'search'); }
    const indexer = GetSiteIndexController();
    const searcher = GetLocalSearchController();
    let index = $state(indexer.State.Value);
    let activity = $state(indexer.Activity.Value);
    let actionError = $state('');
    let initialized = $state(false);
    const observeIndex = value => { index = value; };
    const observeActivity = value => { activity = value; };
    indexer.State.Subscribe(observeIndex); indexer.Activity.Subscribe(observeActivity);
    onDestroy(() => { indexer.State.Unsubscribe(observeIndex); indexer.Activity.Unsubscribe(observeActivity); });
    onMount(() => { void searcher.Initialize(); heading?.focus(); void indexer.Initialize().then(() => { initialized = true; }).catch(() => { actionError = 'Cannot open the catalog ledger. No update has started.'; }); });
    async function command(action: 'start' | 'resume' | 'pause' | 'cancel', siteId?: string) {
        actionError = '';
        try {
            if (action === 'start') await indexer.Start(siteId);
            else if (action === 'resume') await indexer.Resume();
            else await indexer.Stop(action === 'cancel');
        } catch { actionError = 'Cannot start this update. Resume or cancel the existing job first, or check local storage access.'; }
    }
    let completed = $derived(index.job?.items.filter(item => !['queued', 'updating'].includes(item.state)).length ?? 0);
    let eligible = $derived(new Set(ArabicCatalogSources(HakuNeko.PluginController.WebsitePlugins).map(source => source.id)));
    let summaries = $derived(new Map(index.sites.map(site => [site.siteId, site])));
    let query = $state('');
    let scope: SiteScope = $state('arabic');
    let page = $state(1);
    const pageSize = 20;
    let sites = $derived(FilterHubSites(HakuNeko.PluginController.WebsitePlugins, query, scope));
    let pages = $derived(Math.max(1, Math.ceil(sites.length / pageSize)));
    let visible = $derived(sites.slice((page - 1) * pageSize, page * pageSize));
    $effect(() => { query; scope; page = 1; });
</script>

<section id="ArabicManga" lang="en" dir="ltr" aria-labelledby="arabic-manga-title" data-testid="arabic-manga-hub">
    <header class="hub-heading"><div><h1 id="arabic-manga-title" tabindex="-1" bind:this={heading}>Arabic Manga</h1><p>Your saved Arabic manga catalogs</p></div><Button kind="ghost" size="small" onclick={() => (UI.page = 'media')}>Back to Media List</Button></header>
    <nav aria-label="Arabic Manga sections">
        <button aria-current={['search','selections'].includes(UI.hubSection) ? 'page' : undefined} onclick={() => chooseSection('search')}>Search</button>
        <button aria-current={UI.hubSection === 'sites' ? 'page' : undefined} onclick={() => chooseSection('sites')}>Sites</button>
        <button aria-current={UI.hubSection === 'queue' ? 'page' : undefined} onclick={() => chooseSection('queue')}>Downloads</button>
    </nav>
    <div class="update-bar" data-testid="catalog-controls">
        <Button size="small" kind="secondary" disabled={!initialized || activity.owned || !!index.job && !['finished','cancelled'].includes(index.job.state)} onclick={() => command('start')}>{UI.hubSection === 'sites' ? 'Update All Arabic Sites' : 'Update All'}</Button>
        {#if index.job && !['finished','cancelled'].includes(index.job.state)}
            <Button size="small" kind="ghost" disabled={!initialized || activity.owned} onclick={() => command('resume')}>Resume Update</Button>
            <Button size="small" kind="ghost" disabled={!activity.owned} onclick={() => command('pause')}>Pause Update</Button>
            <Button size="small" kind="danger-ghost" disabled={!initialized} onclick={() => command('cancel')}>Cancel Update</Button>
        {/if}
        <span>{index.sites.filter(site => eligible.has(site.siteId) && site.count > 0).length} saved libraries / {eligible.size} Arabic sites</span>
        {#if index.job}<span role="status">{IndexJobStateLabel[index.job.state]} · {completed}/{index.job.items.length} sites · {index.job.items.length - completed} remaining</span>{/if}
        {#if index.job?.current}<strong>Updating: {HakuNeko.PluginController.WebsitePlugins.find(site => site.Identifier === index.job.current)?.Title ?? index.job.current}</strong>{/if}
    </div>
    {#if activity.draining}<p role="status">Waiting for an older connector request to settle before another site can start.</p>{/if}
    {#if actionError || activity.error}<p role="alert">{actionError || activity.error}</p>{/if}
    {#if ['search','selections'].includes(UI.hubSection)}
        <SharedSearch />
    {:else if UI.hubSection === 'queue'}
        <PersonalQueue />
    {:else}
        <div class="filters"><label>Find a site<input type="search" data-testid="arabic-site-filter" bind:value={query} placeholder="Name, ID or host" /></label>
            <label>Language support<select bind:value={scope} data-testid="arabic-site-scope"><option value="arabic">Explicit Arabic support</option><option value="multilingual-unconfirmed">Multilingual — Arabic unconfirmed</option></select></label></div>
        <div class="preference"><PluginOrder english /><small>Language tags identify sources; catalog availability does not certify image downloads.</small></div>
        <p role="status">{sites.length} sites · Page {page} of {pages}</p>
        <div class="sites">
        {#each visible as site (site.Identifier)}
            {@const saved = summaries.get(site.Identifier)}
            {@const observation = SiteObservation(site.Identifier)}
            <article data-testid="arabic-site" data-site-id={site.Identifier}>
                <div class="card-title"><h2 dir="auto">{site.Title}</h2><span class:available={!!saved?.count} class="badge">{saved?.count ? 'Searchable' : saved ? 'No saved library' : 'Not checked'}</span></div>
                <p class="host" dir="ltr">{site.URI.hostname}</p>
                {#if scope === 'multilingual-unconfirmed'}<small class="pending">Arabic unconfirmed</small>{/if}
                <div data-testid="catalog-site-state" class="stats"><strong>{saved?.count ?? '—'} saved manga</strong><span class:error={saved && ['failed','stale'].includes(saved.state)} class:pending={saved && ['updating','review'].includes(saved.state)}>{saved ? IndexStateLabel[saved.state] : 'No update recorded'}</span></div>
                <p class="muted">Last saved update: {saved?.lastSuccess ? new Date(saved.lastSuccess).toLocaleString() : 'Not recorded'}</p>
                {#if saved?.coverage.state !== 'complete'}<small class="pending">Source coverage unconfirmed; saved entries remain searchable.</small>{/if}
                {#if saved?.error}<small class="error">{IndexErrorLabel(saved.error)}</small>{/if}
                <div class="actions"><Button size="small" kind="secondary" disabled={!initialized || !eligible.has(site.Identifier) || activity.owned || !!index.job && !['finished','cancelled'].includes(index.job.state)} onclick={() => command('start', site.Identifier)}>Update</Button><Button size="small" kind="ghost" title="Open this connector in the original Media List" onclick={() => OpenPlugin(UI, site)}>Open Site</Button></div>
                <details><summary>Details</summary><p>ID: <bdi>{site.Identifier}</bdi> · {IsMultilingual(site) ? 'Multilingual' : 'Arabic'}</p><p>{observation.label}</p>{#if observation.recordedAt}<small>User report recorded {observation.recordedAt}; not a live test.</small>{/if}
                    {#if saved}<p>Observed this attempt: {saved.discovered ?? 'Unknown'} · Coverage: {saved.coverage.state}</p><p>{saved.coverage.evidence}</p>{/if}
                    {#if !eligible.has(site.Identifier)}<p>Bulk indexing requires an original manga connector with an explicit Arabic tag.</p>{/if}</details>
            </article>
        {:else}<p>No matching sites. Try another filter.</p>{/each}
        </div>
        <div class="pagination"><Button size="small" kind="ghost" disabled={page <= 1} onclick={() => page--}>Previous</Button><span>{page}/{pages}</span><Button size="small" kind="ghost" disabled={page >= pages} onclick={() => page++}>Next</Button></div>
    {/if}
    <aside>Experimental archiving: 5 manga, 20 chapter attempts, at least 50 GiB free-space reserve. Catalog updates fetch titles only.</aside>
</section>
<style>
    #ArabicManga { height:100%; overflow-y:auto; padding:1rem 1.25rem; color:var(--cds-text-01); background:var(--cds-ui-background); }
    .hub-heading,.card-title,.stats,.actions,.update-bar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.5rem; }
    .hub-heading { margin-bottom:1rem; } h1 { font-size:1.6rem; } h2 { font-size:1rem; overflow-wrap:anywhere; } p { line-height:1.45; margin:.35rem 0; }
    nav { display:flex; gap:.5rem; border-bottom:1px solid var(--cds-ui-03); margin-bottom:.8rem; } nav button { background:transparent; color:var(--cds-text-02); border:0; border-bottom:3px solid transparent; padding:.7rem 1.2rem; font:inherit; cursor:pointer; } nav [aria-current] { border-color:var(--cds-interactive-01); color:var(--cds-text-01); font-weight:600; }
    .update-bar { justify-content:flex-start; padding:.65rem; background:var(--cds-ui-01); border-radius:4px; font-size:.8rem; margin-bottom:1rem; }
    .filters { display:flex; flex-wrap:wrap; gap:.75rem; } label { display:grid; gap:.4rem; flex:1 1 12rem; font-size:.85rem; }
    input,select { background:var(--cds-field-01); color:var(--cds-text-01); border:1px solid var(--cds-ui-03); padding:.6rem; font:inherit; min-width:0; width:100%; }
    .sites { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr)); gap:.75rem; margin:.75rem 0; }
    article { display:flex; flex-direction:column; padding:.85rem; gap:.35rem; background:var(--cds-ui-01); border:1px solid var(--cds-ui-03); border-radius:5px; }
    .badge { border:1px solid var(--cds-ui-03); border-radius:20px; padding:.2rem .5rem; font-size:.7rem; } .available { color:var(--cds-support-success); } .pending { color:var(--cds-support-warning); } .error { color:var(--cds-support-error); } .muted,.host,small { color:var(--cds-text-02); font-size:.78rem; }
    .actions { margin-top:auto; justify-content:flex-start; } details { font-size:.8rem; overflow-wrap:anywhere; } summary { cursor:pointer; color:var(--cds-text-02); } .preference { display:flex; align-items:center; flex-wrap:wrap; gap:1rem; } .pagination { display:flex; justify-content:center; align-items:center; gap:1rem; } aside { margin-top:1rem; font-size:.75rem; color:var(--cds-text-02); }
</style>
