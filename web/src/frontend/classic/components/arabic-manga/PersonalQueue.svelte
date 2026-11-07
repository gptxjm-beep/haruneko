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
    <h2>{selections ? 'Saved selections' : 'Downloads'}</h2>
    <details class="safety"><summary>Safety and compatibility</summary><p role="note">SQLite v10: older Previews may reject this database. Downgrading requires a consistent backup of the previous closed profile; never delete the database or edit its schema version.</p></details>
    {#if !QueueSupported()}<p role="alert">Downloads require the Electron desktop client. No task has started.</p>{:else}
        <p>Selected: {view.summary?.selected ?? 0} • Download entries: {view.summary?.queued ?? 0}. Adding entries does not start downloads.</p>
        {#if selections}<button disabled={busy} onclick={() => action(() => queue.Add())}>Add Selected to Queue</button>{/if}
        {#if !selections}
            <p data-testid="queue-budget">Status: {view.summary?.state} — {view.summary?.reason}. Cumulative budget: {view.summary?.mangasUsed ?? 0}/5 manga, {view.summary?.chaptersStarted ?? 0}/20 chapter attempts. Resume and readding entries do not reset this budget.</p>
            <details><summary>Run details</summary><p data-testid="queue-run-membership">Waiting for a later confirmation: {view.summary?.waitingNextRun ?? 0}. Each confirmed run has fixed membership. Later additions wait for another run; resume preserves the same group.</p>
            <p data-testid="queue-scope-notice">{QueueScopeNotice}</p></details>
            <button disabled={busy || view.summary?.state === 'Running'} onclick={() => action(configure)}>Start Downloads / Resume…</button>
            <button disabled={busy || view.summary?.state !== 'Running'} onclick={() => action(() => GetSelectiveQueueRunner().Pause())}>Pause</button>
            <button disabled={busy} onclick={() => action(() => GetSelectiveQueueRunner().Cancel())}>Cancel</button>
            {#if setup && preferences}
                <div class="setup" data-testid="queue-setup">
                    <h3>Confirm a limited run</h3>
                    <p>Choose scopes before starting. Unverified ordering stays in Review. Destination and policy are fixed after the first run. Ranges use verified oldest-first positions, not numbers guessed from titles. Individual chapter selection is not available.</p>
                    {#if view.summary?.preferences}<p>Saved destination and policy: {rootLabel} • {preferences.format} • Reserve {preferences.reserveGiB} GiB. Languages: {preferences.policy.languages.join(', ') || 'All known languages'}.</p>{:else}<PreferencesForm bind:preferences bind:rootLabel />{/if}
                    <label><input type="checkbox" bind:checked={confirmed} />Start this limited run now, keeping at least 50 GiB in reserve.</label>
                    <button disabled={!confirmed || busy} onclick={start}>Start Downloads</button><button onclick={() => setup = false}>Close without starting</button>
                </div>
            {/if}
        {/if}
        {#if view.message}<p role="status">{view.message}</p>{/if}
        {#if view.error}<p role="alert">{view.error}</p>{/if}
        {#each rows as row, index (row.seq)}
            <article data-testid="personal-entry">
                <h3 dir="auto">{row.title}</h3><p dir="auto">{row.siteName}</p>
                {#if missing[index]}<p class="warning">This reference is missing from the current catalog. Your selection is retained; the catalog may be incomplete.</p>{/if}
                {#if selections}
                    <button disabled={busy} onclick={() => action(() => queue.Select(row, false))}>Remove selection</button>
                    <button disabled={busy} onclick={() => action(() => queue.Add(row))}>Add to Queue</button>
                {:else if 'state' in row}
                    <p class="item-state"><strong>{row.state}</strong>{#if row.progress} · {row.progress.verified}/{row.progress.registered} verified chapters{/if}</p>
                    {#if row.progress?.storage}<p role="alert">Storage stopped: {row.progress.storage}. Completed files are safe. Resolve the storage issue before resuming.</p>{/if}
                    <details><summary>Details and scope</summary><p dir="auto">Source ID: <bdi>{row.mangaId}</bdi></p><p>{row.reason}</p>
                    {#if view.summary?.batchId && !row.inCurrentRun && ['Queued','Paused'].includes(row.state)}<p>Waiting for a later run confirmation.</p>{/if}
                    {#if row.reason.includes('unknown-order')}<p class="warning">Chapter order is unverified. This item needs review before downloading.</p>{/if}
                    {#if row.progress}<p>Verified chapters: {row.progress.verified}/{row.progress.registered} • Verified data: {row.progress.bytes} bytes{row.progress.chapter ? ` • Current chapter: ${row.progress.chapter}` : ''}</p>{/if}
                    <p>Scope: {JSON.stringify(row.scope)}. Completed means the requested registered work is verified, not that the source is complete.</p>
                    {#if !row.sessionId}
                        <label>Chapter scope <select disabled={busy || view.summary?.state === 'Running'} value={row.scope.mode} onchange={event => action(() => scope(row, event.currentTarget.value as 'all' | 'missing' | 'range'))}>
                            <option value="all">{QueueScopeLabels.all}</option><option value="missing">{QueueScopeLabels.missing}</option><option value="range">{QueueScopeLabels.range}</option>
                        </select></label>
                        {#if row.scope.mode === 'range'}
                            <label>From <input type="number" min="1" value={row.scope.from} disabled={busy} onchange={event => action(() => queue.Edit(row.seq, 'up', { mode: 'range', from: Number(event.currentTarget.value), to: row.scope.mode === 'range' ? row.scope.to : 1 }))} /></label>
                            <label>To <input type="number" min="1" value={row.scope.to} disabled={busy} onchange={event => action(() => queue.Edit(row.seq, 'up', { mode: 'range', from: row.scope.mode === 'range' ? row.scope.from : 1, to: Number(event.currentTarget.value) }))} /></label>
                        {/if}
                    {/if}
                    </details><button disabled={busy || view.summary?.state === 'Running'} onclick={() => action(() => queue.Edit(row.seq, 'up'))}>Move up</button>
                    <button disabled={busy || view.summary?.state === 'Running'} onclick={() => action(() => queue.Edit(row.seq, 'down'))}>Move down</button>
                    <button disabled={busy || ['Preparing','Downloading'].includes(row.state)} onclick={() => action(() => queue.Edit(row.seq, 'remove'))}>Remove from downloads</button>
                {/if}
            </article>
        {/each}
        {#if !rows.length}<p>No entries on this page.</p>{/if}
        <button disabled={busy || page === 0} onclick={() => action(async () => { page--; })}>Previous</button>
        <span>Page {page + 1}</span>
        <button disabled={busy || rows.length < 50} onclick={() => action(async () => { cursors[page + 1] = rows.at(-1)?.seq ?? 0; page++; })}>Next</button>
    {/if}
</section>
<style>
    h2 { font-size: 1.15rem; margin: 1rem 0; } h3 { font-size: 1.1rem; } p { margin: .75rem 0; line-height: 1.6; overflow-wrap: anywhere; }
    article { padding: .75rem; margin: .6rem 0; background: var(--cds-ui-01); } button { background: var(--cds-field-01); color: var(--cds-text-01); padding: .45rem .6rem; margin: .2rem; border: 1px solid var(--cds-ui-03); cursor: pointer; } button:disabled { opacity: .5; cursor: default; } .warning { color: var(--cds-support-warning); }
    summary { cursor:pointer; color:var(--cds-text-02); font-size:.8rem; } details { margin:.5rem 0; } .item-state { color:var(--cds-text-01); font-size:.85rem; }
</style>
