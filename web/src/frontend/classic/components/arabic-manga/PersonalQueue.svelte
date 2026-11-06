<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { GetSelectiveQueueController, QueueSupported } from '../../../../engine/archive/SelectiveQueueController';
    import { GetLocalSearchController } from '../../../../engine/search/LocalSearchController';
    import type { SelectedManga, QueueManga } from '../../../../../../app/electron/src/archive/SelectiveQueueContract';
    import { QueueScopeLabels, QueueScopeNotice } from '../../../../../../app/electron/src/archive/SelectiveQueueContract';
    import { GetArchiveUIController } from '../../../../engine/archive/ArchiveUIController';
    import { GetSelectiveQueueRunner } from '../../../../engine/archive/SelectiveQueueRunner';
    import type { ArchivePreferences } from '../../../../../../app/electron/src/archive/ArchiveUIContract';
    import PreferencesForm from '../archiving/ArchivePreferencesForm.svelte';
    let { selections = false }: { selections?: boolean } = $props();
    const queue = GetSelectiveQueueController();
    let view = $state(queue.State.Value), rows = $state<(SelectedManga | QueueManga)[]>([]), missing = $state<boolean[]>([]), page = $state(0), cursors = $state([0]);
    let busy = $state(false);
    let preferences: ArchivePreferences = $state(), rootLabel = $state(''), confirmed = $state(false), setup = $state(false);
    let timer: ReturnType<typeof setInterval>;
    let loadSerial = 0, polling = false;
    onDestroy(() => { clearInterval(timer); loadSerial++; });
    const observe = value => { view = value; };
    queue.State.Subscribe(observe); onDestroy(() => queue.State.Unsubscribe(observe));
    async function load() {
        if (!QueueSupported()) return;
        const serial = ++loadSerial;
        await queue.Refresh();
        const next = selections ? await queue.Selections(cursors[page]) : await queue.List(page * 50);
        const found = await GetLocalSearchController().Client.Contains(next);
        if (serial !== loadSerial) return;
        rows = next; missing = found.map(exists => !exists);
    }
    async function action(work: () => Promise<void>) { busy = true; queue.ClearError(); try { await work(); await load(); } catch(error) { queue.Error(error); } finally { busy = false; } }
    onMount(() => { void action(async () => {}); timer = setInterval(() => { if (!selections && !busy && !polling) { polling = true; void load().catch(error => queue.Error(error)).finally(() => { polling = false; }); } }, 2000); });
    async function configure() {
        const defaults = await GetArchiveUIController().Preferences();
        preferences = $state.snapshot(view.summary?.preferences ?? defaults.preferences); rootLabel = view.summary?.preferences ? view.summary.rootLabel : defaults.rootLabel; confirmed = false; setup = true;
    }
    function start() {
        setup = false;
        void GetSelectiveQueueRunner().Start($state.snapshot(preferences), confirmed).catch(error => queue.Error(error)).finally(() => { void load().catch(error => queue.Error(error)); });
        void queue.Refresh().catch(error => queue.Error(error));
    }
    async function scope(row: QueueManga, mode: 'all' | 'missing' | 'range') {
        await queue.Edit(row.seq, 'up', mode === 'range' ? { mode, from: 1, to: 1 } : { mode });
    }
</script>
<section data-testid={selections ? 'personal-selections' : 'personal-queue'}>
    <h2>{selections ? 'الاختيارات المحفوظة' : 'Download Queue'}</h2>
    <p role="note">تنبيه بيانات: يستخدم هذا الإصدار SQLite v10. قد ترفض Preview قديمة قاعدة v9 أو أحدث؛ الرجوع يتطلب نسخة احتياطية متسقة من ملف تعريف الإصدار السابق بعد إغلاقه، وليس حذف القاعدة أو خفض إصدارها يدويًا.</p>
    {#if !QueueSupported()}<p role="alert">هذه الوظيفة تتطلب Electron؛ لم تبدأ أي مهمة.</p>{:else}
        <p>المحدد: {view.summary?.selected ?? 0} • عناصر القائمة: {view.summary?.queued ?? 0}. الإضافة لا تبدأ التنزيل.</p>
        {#if selections}<button disabled={busy} onclick={() => action(() => queue.Add())}>Add Selected to Queue</button>{/if}
        {#if !selections}
            <p data-testid="queue-budget">الحالة: {view.summary?.state} — {view.summary?.reason}. الميزانية التراكمية: {view.summary?.mangasUsed ?? 0}/5 مانجات، {view.summary?.chaptersStarted ?? 0}/20 محاولة. الاستئناف والإزالة وإعادة الإضافة لا تصفر الميزانية.</p>
            <p data-testid="queue-run-membership">عناصر مؤجلة لتأكيد تشغيل لاحق: {view.summary?.waitingNextRun ?? 0}. تثبت مجموعة التشغيل عند التأكيد؛ الإضافة أو إعادة الإضافة أثناء التشغيل لا تضم العنصر إليها، والاستئناف يحافظ على المجموعة نفسها.</p>
            <p data-testid="queue-scope-notice">{QueueScopeNotice}</p>
            <button disabled={busy || view.summary?.state === 'Running'} onclick={() => action(configure)}>Start Downloads / Resume…</button>
            <button disabled={busy || view.summary?.state !== 'Running'} onclick={() => action(() => GetSelectiveQueueRunner().Pause())}>Pause</button>
            <button disabled={busy} onclick={() => action(() => GetSelectiveQueueRunner().Cancel())}>Cancel</button>
            {#if setup && preferences}
                <div class="setup" data-testid="queue-setup">
                    <h3>تأكيد تشغيل محدود</h3>
                    <p>اضبط نطاق كل عنصر قبل بدء التشغيل. الترتيب المجهول يبقى Review. بعد أول تشغيل تثبت الوجهة والسياسة؛ لا توجد جلسات خفية تصفر الميزانية. النطاق العددي يعتمد مواضع القائمة الموثقة من الأقدم، وليس أرقام العناوين. الفصول المختارة منفردة غير مدعومة في هذه النسخة.</p>
                    {#if view.summary?.preferences}<p>الوجهة والسياسة محفوظتان وثابتتان لهذه القائمة: {rootLabel} • {preferences.format} • احتياطي {preferences.reserveGiB} GiB. اللغات: {preferences.policy.languages.join(', ') || 'جميع اللغات المعروفة'}.</p>{:else}<PreferencesForm bind:preferences bind:rootLabel />{/if}
                    <label><input type="checkbox" bind:checked={confirmed} />أؤكد بدء التجربة المحدودة الآن، مع احتياطي 50 GiB على الأقل.</label>
                    <button disabled={!confirmed || busy} onclick={start}>Start Downloads</button><button onclick={() => setup = false}>إغلاق الإعداد دون تشغيل</button>
                </div>
            {/if}
        {/if}
        {#if view.message}<p role="status">{view.message}</p>{/if}
        {#if view.error}<p role="alert">{view.error}</p>{/if}
        {#each rows as row, index (row.seq)}
            <article data-testid="personal-entry">
                <h3 dir="auto">{row.title}</h3><p dir="auto">{row.siteName} • {row.mangaId}</p>
                {#if missing[index]}<p class="warning">مرجع محفوظ لم يعد موجودًا في الفهرس المقبول الحالي؛ لم يُحذف اختيارك. قد يكون الفهرس ناقصًا.</p>{/if}
                {#if selections}
                    <button disabled={busy} onclick={() => action(() => queue.Select(row, false))}>إزالة من الاختيارات</button>
                    <button disabled={busy} onclick={() => action(() => queue.Add(row))}>Add to Queue</button>
                {:else if 'state' in row}
                    <p>{row.state} — {row.reason}</p>
                    {#if view.summary?.batchId && !row.inCurrentRun && ['Queued','Paused'].includes(row.state)}<p>ينتظر تأكيد تشغيل لاحق؛ ليس ضمن مجموعة التشغيل الحالية.</p>{/if}
                    {#if row.reason.includes('unknown-order')}<p class="warning">ترتيب الفصول غير موثق؛ لن يُستنتج من عناوينها ولن تُجبر الجلسة على التنزيل.</p>{/if}
                    {#if row.progress}<p>الفصول المتحقق منها: {row.progress.verified}/{row.progress.registered} • بيانات موثقة: {row.progress.bytes} بايت{row.progress.chapter ? ` • الفصل الجاري: ${row.progress.chapter}` : ''}</p>{#if row.progress.storage}<p role="alert">توقف التخزين: {row.progress.storage}. الملفات المكتملة محفوظة؛ يلزم معالجة المساحة أو القرص قبل الاستئناف.</p>{/if}{/if}
                    <p>النطاق: {JSON.stringify(row.scope)}. Completed يعني تحقق العمل المطلوب، ولا يثبت اكتمال المصدر.</p>
                    {#if !row.sessionId}
                        <label>نطاق الفصول <select disabled={busy || view.summary?.state === 'Running'} value={row.scope.mode} onchange={event => action(() => scope(row, event.currentTarget.value as 'all' | 'missing' | 'range'))}>
                            <option value="all">{QueueScopeLabels.all}</option><option value="missing">{QueueScopeLabels.missing}</option><option value="range">{QueueScopeLabels.range}</option>
                        </select></label>
                        {#if row.scope.mode === 'range'}
                            <label>من <input type="number" min="1" value={row.scope.from} disabled={busy} onchange={event => action(() => queue.Edit(row.seq, 'up', { mode: 'range', from: Number(event.currentTarget.value), to: row.scope.mode === 'range' ? row.scope.to : 1 }))} /></label>
                            <label>إلى <input type="number" min="1" value={row.scope.to} disabled={busy} onchange={event => action(() => queue.Edit(row.seq, 'up', { mode: 'range', from: row.scope.mode === 'range' ? row.scope.from : 1, to: Number(event.currentTarget.value) }))} /></label>
                        {/if}
                    {/if}
                    <button disabled={busy || view.summary?.state === 'Running'} onclick={() => action(() => queue.Edit(row.seq, 'up'))}>رفع</button>
                    <button disabled={busy || view.summary?.state === 'Running'} onclick={() => action(() => queue.Edit(row.seq, 'down'))}>خفض</button>
                    <button disabled={busy || ['Preparing','Downloading'].includes(row.state)} onclick={() => action(() => queue.Edit(row.seq, 'remove'))}>إزالة من القائمة دون حذف الملفات</button>
                {/if}
            </article>
        {/each}
        {#if !rows.length}<p>لا توجد عناصر في هذه الصفحة.</p>{/if}
        <button disabled={busy || page === 0} onclick={() => action(async () => { page--; })}>السابق</button>
        <span>صفحة {page + 1}</span>
        <button disabled={busy || rows.length < 50} onclick={() => action(async () => { cursors[page + 1] = rows.at(-1)?.seq ?? 0; page++; })}>التالي</button>
    {/if}
</section>
<style>
    h2 { font-size: 1.5rem; margin: 1rem 0; } h3 { font-size: 1.1rem; } p { margin: .75rem 0; line-height: 1.6; overflow-wrap: anywhere; }
    article { padding: 1rem; margin: 1rem 0; background: var(--cds-ui-01); } button { background: var(--cds-field-01); color: var(--cds-text-01); padding: .6rem; margin: .3rem; border: 1px solid var(--cds-ui-03); cursor: pointer; } button:disabled { opacity: .5; cursor: default; } .warning { color: var(--cds-support-warning); }
</style>
