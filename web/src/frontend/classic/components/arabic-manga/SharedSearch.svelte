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

    const controller = GetLocalSearchController();
    const queue = GetSelectiveQueueController();
    let queueView = $state(queue.State.Value);
    const queueObserver = value => { queueView = value; };
    queue.State.Subscribe(queueObserver);
    const reference = (row: SearchRow) => ({ siteId: row.siteId, mangaId: row.mangaId, title: row.title, siteName: controller.Sites().find(site => site.id === row.siteId)?.title ?? row.siteId });
    async function queueAction(action: () => Promise<void>) { try { await action(); } catch(error) { queue.Error(error); } }
    $effect(() => { if (view.result && QueueSupported()) void queueAction(() => queue.Flags(view.result!.groups.flatMap(group => group.rows.map(reference)))); });
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
        } catch { if (token === openToken) openingError = 'تعذر فتح المانجا: الموصل غير متاح أو لم تعد هويتها في الفهرس المقبول. نتائج البحث الأخرى محفوظة؛ عند تعذر الوصول الحي يعرض مسار المصدر خطأه المعتاد.'; }
        finally { if (token === openToken) opening = false; }
    }
</script>
<section aria-labelledby="shared-search-title" data-testid="shared-search">
    <h2 id="shared-search-title">البحث المشترك في الفهارس المحلية</h2>
    {#if QueueSupported()}
        <p data-testid="selection-total">المحدد: {queueView.summary?.selected ?? 0} • في القائمة: {queueView.summary?.queued ?? 0}</p>
        <Button kind="secondary" onclick={() => UI.hubSection = 'selections'}>مراجعة الاختيارات</Button>
        <Button kind="secondary" onclick={() => queueAction(() => queue.Add())}>Add Selected to Queue</Button>
        {#if queueView.message}<p role="status">{queueView.message}</p>{/if}
        {#if queueView.error}<p role="alert">{queueView.error}</p>{/if}
    {:else}<p>حفظ الاختيارات وقائمة التنزيل يتطلبان Electron. البحث المحلي متاح.</p>{/if}
    <p class="intro">البحث في القوائم المقبولة المحفوظة فقط؛ الكتابة لا تتصل بالمواقع ولا تُحدّث الفهارس. فتح نتيجة يستخدم موصلها الأصلي وقد يجلب قائمة فصولها؛ لا يبدأ تنزيل الصور.</p>
    <div class="filters">
        <label>اسم المانجا<input data-testid="shared-search-query" type="search" maxlength="256" value={view.preference.query} disabled={!loaded} oninput={event => change({ query: event.currentTarget.value })} placeholder="One Piece أو عنوان عربي" /></label>
        <label>المصدر<select data-testid="shared-search-site" value={view.preference.siteId} disabled={!loaded} onchange={event => change({ siteId: event.currentTarget.value })}>
            <option value="">جميع المصادر العربية</option>
            {#each controller.Sites() as site (site.id)}<option value={site.id}>{site.title}</option>{/each}
        </select></label>
        <label class="fuzzy" title="التقريب للاستعلامات من 3 إلى 64 حرفًا، بخطأ أو خطأين؛ لا تُضاف أسماء بديلة."><input data-testid="shared-search-fuzzy" type="checkbox" checked={view.preference.fuzzy} disabled={!loaded} onchange={event => change({ fuzzy: event.currentTarget.checked })} />بحث تقريبي اختياري</label>
    </div>
    {#if view.status === 'searching'}<p role="status">جارٍ البحث ومزامنة مراجعات الفهارس المحلية…</p>{/if}
    {#if view.error}<p role="alert">{view.error}</p><Button kind="secondary" onclick={async () => { await controller.Initialize(); controller.Query({}, 0); }}>إعادة محاولة البحث المحلي</Button>{/if}
    {#if openingError}<p role="alert">{openingError}</p>{/if}
    {#if view.status === 'idle'}<p>اكتب عنوانًا للبحث. يمكن تحديث قوائم المصادر يدويًا من قسم المواقع.</p>{/if}
    {#if view.result}
        <p role="status" data-testid="shared-search-total">{view.result.total} نتيجة محلية • صفحة {view.result.page} من {Math.max(1, Math.ceil(view.result.total / view.result.pageSize))}</p>
        <div class="results" bind:this={panel} data-testid="shared-search-scroll" onscroll={event => { if (view.status !== 'ready' || !event.currentTarget.isConnected) return; lastScroll = event.currentTarget.scrollTop; clearTimeout(scrollTimer); const value = lastScroll; scrollTimer = setTimeout(() => controller.SetScroll(value), 100); }}>
            {#each view.result.groups.filter(group => group.count > 0) as group (group.site.id)}
                <section class="group" data-testid="shared-search-group" data-source-id={group.site.id}>
                    <header><h3 dir="auto">{group.site.title} — {group.count} نتيجة</h3>
                        <p>حالة الفهرس: {IndexStateLabel[group.metadata.state]} • آخر نجاح: {group.metadata.lastSuccess ? new Date(group.metadata.lastSuccess).toLocaleString() : 'غير مسجّل'}</p>
                        {#if StaleIndex(group.metadata)}<p class="warning">فهرس قديم أو يحتاج مراجعة؛ تاريخ غير مسجّل أو أكثر من 7 أيام أو تحديث لم ينجح. النتائج من آخر قائمة مقبولة.</p>{/if}
                        {#if group.metadata.coverage.state !== 'complete'}<p class="warning">تغطية غير مؤكدة: {group.metadata.coverage.state}</p>{/if}
                        <p>دليل التغطية: {group.metadata.coverage.evidence} — هذا لا يثبت سلامة الصور أو اكتمال الفصول.</p>
                    </header>
                    {#each group.rows as row (JSON.stringify([row.siteId, row.mangaId]))}<Result {row} disabled={opening} onopen={open} queueSupported={QueueSupported()} selected={!!queueView.flags[QueueIdentity(row)]} queued={!!queueView.queued[QueueIdentity(row)]} onselect={(item, selected) => queueAction(() => queue.Select(reference(item), selected))} onadd={item => queueAction(() => queue.Add(reference(item)))} />{/each}
                    {#if !group.rows.length}<small>نتائج هذا المصدر في صفحات أخرى.</small>{/if}
                </section>
            {/each}
            {#if !view.result.total}<p data-testid="shared-search-empty">لا توجد نتائج في الفهارس المحلية المطابقة. لم يُرسل طلب إلى أي موقع.</p>{/if}
        </div>
        <div class="pages">
            <Button kind="secondary" size="small" disabled={view.result.page <= 1} onclick={() => change({ page: view.result!.page - 1 })}>صفحة النتائج السابقة</Button>
            <span>{view.result.page}</span>
            <Button kind="secondary" size="small" disabled={view.result.page * view.result.pageSize >= view.result.total} onclick={() => change({ page: view.result!.page + 1 })}>صفحة النتائج التالية</Button>
        </div>
    {/if}
</section>
<style>
    h2 { font-size: 1.4rem; margin: 1rem 0; } .intro, p { line-height: 1.6; margin: .65rem 0; }
    .filters { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; }
    label { display: grid; gap: .5rem; flex: 1 1 15rem; } input, select { background: var(--cds-field-01); color: var(--cds-text-01); border: 1px solid var(--cds-ui-03); font: inherit; padding: .75rem; width: 100%; min-width: 0; }
    label.fuzzy { display: flex; align-items: center; } .fuzzy input { width: auto; }
    .results { max-height: 55vh; overflow-y: auto; overflow-anchor: none; margin: 1rem 0; }
    .group { background: var(--cds-ui-01); margin: 1rem 0; } header { padding: .75rem 1rem; border-bottom: 1px solid var(--cds-ui-03); } header h3 { font-size: 1.1rem; }
    header p, small { font-size: .8rem; } .warning { color: var(--cds-support-warning); } .pages { display: flex; align-items: center; justify-content: center; gap: 1rem; }
</style>
