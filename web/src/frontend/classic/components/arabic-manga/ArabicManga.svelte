<script lang="ts">
    import { onMount } from 'svelte';
    import { Button, Tile } from 'carbon-components-svelte';
    import { FilterHubSites, IsMultilingual, OpenPlugin, SiteObservation, type SiteScope } from '../../models/PluginPresentation';
    import { Store as UI } from '../../stores/Stores.svelte';
    import PluginOrder from './PluginOrder.svelte';

    let heading: HTMLHeadingElement;
    onMount(() => heading?.focus());
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
        <span aria-current="page">المواقع</span>
        <span>البحث المشترك — غير متاح بعد</span>
        <span>المكتبة — غير متاحة بعد</span>
        <span>التنزيلات الانتقائية — غير متاحة بعد</span>
    </nav>
    <p class="intro">اختر موقعًا لفتح قائمته وبحثه الأصلي في Media List. فتح المركز أو اختيار موقع لا يحدّث الفهارس ولا يبدأ تنزيلًا.</p>
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
    <aside>الأرشفة الشاملة ما زالت تجريبية. Archive Site يحتفظ بجلساته وحدوده: خمس مانجات وعشرون محاولة فصل، واحتياطي مساحة 50 GiB على الأقل.</aside>
</section>

<style>
    section { height: 100%; overflow-y: auto; padding: 1.25rem; color: var(--cds-text-01); }
    header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
    h1 { font-size: 1.8rem; } h2 { font-size: 1.1rem; overflow-wrap: anywhere; }
    nav { display: flex; flex-wrap: wrap; gap: 1rem; border-bottom: 1px solid var(--cds-ui-03); padding: .75rem 0; }
    nav span { color: var(--cds-text-02); } nav [aria-current] { color: var(--cds-text-01); font-weight: bold; }
    .intro, .note, .preference, aside { margin: 1rem 0; line-height: 1.6; }
    .note, small { color: var(--cds-text-02); }
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
