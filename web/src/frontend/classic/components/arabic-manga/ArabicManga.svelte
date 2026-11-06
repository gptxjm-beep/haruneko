<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { Button, Tile } from 'carbon-components-svelte';
    import { FilterHubSites, IsMultilingual, OpenPlugin, SiteObservation, type SiteScope } from '../../models/PluginPresentation';
    import { Store as UI } from '../../stores/Stores.svelte';
    import { GetSiteIndexController, ArabicCatalogSources, IndexStateLabel, IndexJobStateLabel, IndexErrorLabel } from '../../../../engine/catalog/SiteIndexController';
    import SharedSearch from './SharedSearch.svelte';
    import PersonalQueue from './PersonalQueue.svelte';
    import { GetLocalSearchController } from '../../../../engine/search/LocalSearchController';
    import PluginOrder from './PluginOrder.svelte';

    let heading: HTMLHeadingElement;
    let sectionChanged = false;
    async function chooseSection(section: 'sites' | 'search' | 'selections' | 'queue') { sectionChanged = true; UI.hubSection = section; await searcher.Initialize(); searcher.SetActive(section === 'search'); }
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
    onMount(() => { void searcher.Initialize().then(() => { if (!sectionChanged && searcher.State.Value.preference.active) UI.hubSection = 'search'; }); heading?.focus(); void indexer.Initialize().then(() => { initialized = true; }).catch(() => { actionError = 'تعذر فتح سجل الفهرسة؛ لم يبدأ تحديث.'; }); });
    async function command(action: 'start' | 'resume' | 'pause' | 'cancel') {
        actionError = '';
        try {
            if (action === 'start') await indexer.Start();
            else if (action === 'resume') await indexer.Resume();
            else await indexer.Stop(action === 'cancel');
        } catch { actionError = 'تعذر تنفيذ الطلب: توجد عملية قائمة أو سجل يحتاج استئنافًا، أو أن التخزين/القفل غير متاح.'; }
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

<section id="ArabicManga" lang="ar" dir="rtl" aria-labelledby="arabic-manga-title" data-testid="arabic-manga-hub">
    <header>
        <div><h1 id="arabic-manga-title" tabindex="-1" bind:this={heading}>Arabic Manga</h1><p>مركز المانجا العربية — المواقع المدعومة</p></div>
        <Button kind="secondary" onclick={() => (UI.page = 'media')}>العودة إلى Media List</Button>
    </header>
    <nav aria-label="أقسام مركز المانجا العربية">
        <button type="button" aria-current={UI.hubSection === 'sites' ? 'page' : undefined} onclick={() => chooseSection('sites')}>المواقع</button>
        <button type="button" aria-current={UI.hubSection === 'search' ? 'page' : undefined} onclick={() => chooseSection('search')}>البحث المشترك</button>
        <span>المكتبة — غير متاحة بعد</span>
        <button type="button" aria-current={UI.hubSection === 'selections' ? 'page' : undefined} onclick={() => chooseSection('selections')}>الاختيارات</button>
        <button type="button" aria-current={UI.hubSection === 'queue' ? 'page' : undefined} onclick={() => chooseSection('queue')}>Download Queue</button>
    </nav>
    {#if UI.hubSection === 'search'}
        <SharedSearch />
    {:else if UI.hubSection === 'selections' || UI.hubSection === 'queue'}
        {#key UI.hubSection}<PersonalQueue selections={UI.hubSection === 'selections'} />{/key}
    {:else}
    <p class="intro">اختر موقعًا لفتح قائمته وبحثه الأصلي في Media List. فتح المركز أو اختيار موقع لا يحدّث الفهارس ولا يبدأ تنزيلًا.</p>
    <section class="index-controls" aria-label="تحديث فهارس المواقع" data-testid="catalog-controls">
        <Button disabled={!initialized || activity.owned || !!index.job && !['finished', 'cancelled'].includes(index.job.state)} onclick={() => command('start')}>Update All Arabic Sites</Button>
        {#if index.job && !['finished', 'cancelled'].includes(index.job.state)}
            <Button kind="secondary" disabled={!initialized || activity.owned} onclick={() => command('resume')}>استئناف تحديث الفهارس</Button>
            <Button kind="secondary" disabled={!activity.owned} onclick={() => command('pause')}>إيقاف مؤقت</Button>
            <Button kind="danger" disabled={!initialized} onclick={() => command('cancel')}>إلغاء تحديث الفهارس</Button>
        {/if}
        <p>تحديث قوائم المانجا فقط، موقع واحد في المرة. لا فصول ولا صور. عدد الموصلات المؤهلة: {eligible.size}. المواقع دون وسم عربي صريح والموصلات التي لا تدعم فهرسة المانجا خارج هذه العملية.</p>
        {#if index.job}<p role="status">حالة العملية: {IndexJobStateLabel[index.job.state]} • منجز {completed} / {index.job.items.length} • متبقٍ {index.job.items.length - completed}</p>{/if}
        {#if activity.draining}<p role="alert">ننتظر انتهاء طلب موصل قديم لا يدعم الإلغاء. لن يتوازى معه موقع آخر. يمكنك طلب الإيقاف أو الإلغاء؛ إذا لم ينتهِ الطلب يلزم إغلاق التطبيق قبل استئناف جديد.</p>{/if}
        {#if actionError || activity.error}<p role="alert">{actionError || activity.error}</p>{/if}
    </section>
    <div class="filters">
        <label>تصفية المواقع
            <input type="search" data-testid="arabic-site-filter" bind:value={query} placeholder="اسم الموقع أو معرّفه أو مضيفه" />
        </label>
        <label>إعلان اللغة
            <select bind:value={scope} data-testid="arabic-site-scope">
                <option value="arabic">العربية معلنة صراحة</option>
                <option value="multilingual-unconfirmed">متعدد اللغات — العربية غير مؤكدة</option>
            </select>
        </label>
    </div>
    <p class="note">{scope === 'arabic' ? 'هذه المواقع تحمل وسم اللغة العربية في الموصل. الوسم لا يثبت سلامة الموقع أو اكتمال فهرسه.' : 'هذه مواقع متعددة اللغات دون وسم عربي صريح. لا نعتبر دعم العربية مثبتًا فيها.'}</p>
    <div class="preference"><PluginOrder /><small>يطبق هذا التفضيل على قوائم اختيار الموصلات لجميع اللغات. مواقع المركز مرتبة أبجديًا.</small></div>
    <p role="status" aria-live="polite">{sites.length} موقعًا مطابقًا • صفحة {page} من {pages}</p>
    <div class="sites">
        {#each visible as site (site.Identifier)}
            {@const observation = SiteObservation(site.Identifier)}
            <Tile>
                <article data-testid="arabic-site" data-site-id={site.Identifier}>
                    <h2 dir="auto">{site.Title}</h2>
                    <p class="host" dir="ltr">{site.URI.hostname} · {site.Identifier}</p>
                    <p>{scope === 'arabic' ? 'العربية معلنة' : 'العربية غير مؤكدة'}{IsMultilingual(site) ? ' • متعدد اللغات' : ''}</p>
                    {#if !eligible.has(site.Identifier)}<p>غير مؤهل للتحديث الجماعي: يلزم موصل مانجا يعلن دعم العربية صراحة. هذا ليس حكمًا على سلامة الموقع.</p>{/if}
                    {#if summaries.has(site.Identifier)}
                        {@const saved = summaries.get(site.Identifier)}
                        <div data-testid="catalog-site-state">
                            <strong>{IndexStateLabel[saved.state]}</strong>
                            {#if saved.state !== 'succeeded' && (saved.count || saved.lastSuccess)}<p>فهرس قديم محفوظ؛ لن يُستبدل بنتيجة غير موثوقة.</p>{/if}
                            <p>المحفوظ: {saved.count} • المكتشف في المحاولة: {saved.discovered ?? 'غير معروف'}</p>
                            <p>آخر نجاح: {saved.lastSuccess ? new Date(saved.lastSuccess).toLocaleString() : 'غير مسجّل'}</p>
                            <p>آخر محاولة: {saved.lastAttempt ? new Date(saved.lastAttempt).toLocaleString() : 'غير مسجّلة'}</p>
                            <p>تغطية الفهرس المحفوظ: {saved.coverage.state} — {saved.coverage.evidence}</p>
                            {#if saved.error}<p role="status">{IndexErrorLabel(saved.error)}</p>{/if}
                        </div>
                    {/if}
                    <p class="observation">{observation.label}</p>
                    {#if observation.recordedAt}<small>تاريخ تسجيل البلاغ: {observation.recordedAt} — ليست نتيجة فحص حي من المركز.</small>{/if}
                    <Button size="small" onclick={() => OpenPlugin(UI, site)}>فتح قائمة المانجا</Button>
                </article>
            </Tile>
        {:else}
            <p class="empty">لا توجد مواقع مطابقة. غيّر التصفية أو إعلان اللغة.</p>
        {/each}
    </div>
    <div class="pagination" aria-label="صفحات المواقع">
        <Button kind="secondary" size="small" disabled={page <= 1} onclick={() => page--}>السابق</Button>
        <span>{page} / {pages}</span>
        <Button kind="secondary" size="small" disabled={page >= pages} onclick={() => page++}>التالي</Button>
    </div>
    {/if}
    <aside>الأرشفة الشاملة ما زالت تجريبية. Archive Site يحتفظ بجلساته وحدوده: خمس مانجات وعشرون محاولة فصل، واحتياطي مساحة 50 GiB على الأقل.</aside>
</section>

<style>
    #ArabicManga { height: 100%; overflow-y: auto; padding: 1.25rem; color: var(--cds-text-01); }
    header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
    h1 { font-size: 1.8rem; } h2 { font-size: 1.1rem; overflow-wrap: anywhere; }
    nav { display: flex; flex-wrap: wrap; gap: 1rem; border-bottom: 1px solid var(--cds-ui-03); padding: .75rem 0; }
    nav button { background: transparent; border: none; font: inherit; cursor: pointer; padding: 0; color: var(--cds-text-01); }
    nav span { color: var(--cds-text-02); } nav [aria-current] { color: var(--cds-text-01); font-weight: bold; }
    .intro, .note, .preference, aside { margin: 1rem 0; line-height: 1.6; }
    .note, small { color: var(--cds-text-02); }
    .index-controls { margin: 1rem 0; padding: 1rem; border: 1px solid var(--cds-ui-03); line-height: 1.6; }
    .filters { display: flex; flex-wrap: wrap; gap: 1rem; }
    label { display: grid; gap: .5rem; flex: 1 1 15rem; }
    input, select { padding: .75rem; min-width: 0; width: 100%; background: var(--cds-field-01); color: var(--cds-text-01); border: 1px solid var(--cds-ui-03); font: inherit; }
    .sites { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); gap: 1rem; margin: 1rem 0; }
    article { display: flex; flex-direction: column; gap: .65rem; height: 100%; }
    .host { overflow-wrap: anywhere; font-size: .8rem; color: var(--cds-text-02); }
    .observation { line-height: 1.5; flex: 1; }
    .pagination { display: flex; justify-content: center; gap: 1rem; align-items: center; }
    aside { padding: .75rem; border-inline-start: 3px solid var(--cds-ui-03); }
</style>
