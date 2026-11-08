<script lang="ts">
    import MangaInfoEditor from './MangaInfoEditor.svelte';
    import { OpenHubManga } from '../../models/HubNavigation';
    import { ArchiveClient } from '../../../../engine/archive/ArchiveClient';
    import { onMount, onDestroy } from 'svelte';
    import { GetSelectiveQueueController, QueueSupported } from '../../../../engine/archive/SelectiveQueueController';
    import { GetLocalSearchController } from '../../../../engine/search/LocalSearchController';
    import type { SelectedManga, QueueManga } from '../../../../../../app/electron/src/archive/SelectiveQueueContract';
    import { QueueScopeLabels, QueueScopeNotice } from '../../../../../../app/electron/src/archive/SelectiveQueueContract';
    import { GetArchiveUIController } from '../../../../engine/archive/ArchiveUIController';
    import { GetSelectiveQueueRunner } from '../../../../engine/archive/SelectiveQueueRunner';
    import type { ArchivePreferences } from '../../../../../../app/electron/src/archive/ArchiveUIContract';
    import PreferencesForm from '../archiving/ArchivePreferencesForm.svelte';
    import QueueChapters from './QueueChapters.svelte';
    import DownloadReport from './DownloadReport.svelte';
    import SavedCover from './SavedCover.svelte';
    import { StorageControllerBrowser } from '../../../../engine/StorageControllerBrowser';
    import { Store } from '../../../../engine/StorageController';
    let { selections = false }: { selections?: boolean } = $props();
    const queue = GetSelectiveQueueController();
    let view = $state(queue.State.Value), rows = $state<(SelectedManga | QueueManga)[]>([]), missing = $state<boolean[]>([]), page = $state(0), cursors = $state([0]);
    let busy = $state(false);
    let downloadDetails = $state(false);
    const storage = new StorageControllerBrowser();
    onMount(() => { void storage.LoadPersistent<boolean>(Store.Settings, 'arabic-download-manga-details').then(value => { downloadDetails = value === true; }).catch(() => {}); });
    let preferences: ArchivePreferences = $state(), rootLabel = $state(''), confirmed = $state(false), setup = $state(false);
    let timer: ReturnType<typeof setInterval>;
    let loadSerial = 0, polling = false;
    const audited = new Set<string>();
    onDestroy(() => { clearInterval(timer); loadSerial++; });
    const observe = value => { view = value; };
    queue.State.Subscribe(observe); onDestroy(() => queue.State.Unsubscribe(observe));
    async function load() {
        if (!QueueSupported()) return;
        const serial = ++loadSerial;
        await queue.Refresh();
        let next: (SelectedManga | QueueManga)[] = selections ? await queue.Selections(cursors[page]) : await queue.List(page * 50);
        let changed = false;
        for (const row of next) if (!selections && 'historyCount' in row && row.historyCount && !audited.has(`${row.seq}:${row.enqueueVersion}:${row.sessionId}`) && view.summary?.state !== 'Running') {
            await queue.Audit(row.seq); audited.add(`${row.seq}:${row.enqueueVersion}:${row.sessionId}`); changed = true;
        }
        if (changed) next = await queue.List(page * 50);
        const found = await GetLocalSearchController().Client.Contains(next);
        if (serial !== loadSerial) return;
        rows = next; missing = found.map(exists => !exists);
    }
    async function action(work: () => Promise<void>, propagate = false) { busy = true; queue.ClearError(); try { await work(); await load(); } catch(error) { queue.Error(error); await load().catch(() => {}); if (propagate) throw error; } finally { busy = false; } }
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
        const policy = { order: row.scope.order ?? 'source', direction: row.scope.direction, sourceIds: row.scope.sourceIds };
        await queue.Edit(row.seq, 'up', mode === 'range' ? { mode, from: 1, to: 1, ...policy } : { mode, ...policy });
    }
    const available = (row: QueueManga) => row.progress?.available ?? (row.scope as any)._available ?? row.scope.sourceIds?.length;
    const selectedCount = (row: QueueManga) => row.scope.mode === 'selected' ? row.scope.ids.length : row.scope.mode === 'range' ? (available(row) >= row.scope.to ? row.scope.to - row.scope.from + 1 : undefined) : available(row);
</script>
<section data-testid={selections ? 'personal-selections' : 'personal-queue'}>
    <h2>{selections ? 'Saved selections' : 'Downloads'}</h2>
    <details class="safety"><summary>Safety and compatibility</summary><p role="note">SQLite v11: older Previews may reject this database. Downgrading requires a consistent backup of the previous closed profile; never delete the database or edit its schema version.</p></details>
    {#if !QueueSupported()}<p role="alert">Downloads require the Electron desktop client. No task has started.</p>{:else}
        <p>Selected: {view.summary?.selected ?? 0} • Download entries: {view.summary?.queued ?? 0}. Adding entries does not start downloads.</p>
        {#if selections}<button disabled={busy} onclick={() => action(() => queue.Add())}>Add Selected to Queue</button>{/if}
        {#if !selections}
            <label><input type="checkbox" checked={downloadDetails} disabled={view.summary?.state === 'Running'} onchange={event => { downloadDetails = event.currentTarget.checked; void storage.SavePersistent(downloadDetails, Store.Settings, 'arabic-download-manga-details').catch(error => queue.Error(error)); }} />Download Manga Details</label>
            <p data-testid="queue-budget">Status: {view.summary?.state} — {view.summary?.reason}. Cumulative budget: {view.summary?.mangasUsed ?? 0}/5 manga, {view.summary?.chaptersStarted ?? 0}/20 chapter attempts. Resume and readding entries do not reset this budget.</p>
            <details><summary>Run details</summary><p data-testid="queue-run-membership">Waiting for a later confirmation: {view.summary?.waitingNextRun ?? 0}. Each confirmed run has fixed membership. Later additions wait for another run; resume preserves the same group.</p>
            <p data-testid="queue-scope-notice">{QueueScopeNotice}</p></details>
            <button disabled={busy || view.summary?.state === 'Running'} onclick={() => action(configure)}>Start Downloads / Resume…</button>
            <button disabled={busy || view.summary?.state !== 'Running'} onclick={() => action(() => GetSelectiveQueueRunner().Pause())}>Pause</button>
            <button disabled={busy} onclick={() => action(() => GetSelectiveQueueRunner().Cancel())}>Cancel</button>
            {#if setup && preferences}
                <div class="setup" data-testid="queue-setup">
                    <h3>Confirm a limited run</h3>
                    <p>Choose scopes before starting. Source Order accepts the connector sequence without claiming chronology. Chronological ordering and numeric ranges need a proven or explicitly confirmed direction. Destination and safety policy stay fixed after the first run. Individual chapter selections use stable IDs.</p>
                    {#if view.summary?.preferences}<p>Saved destination and policy: {rootLabel} • {preferences.format} • Reserve {preferences.reserveGiB} GiB. Languages: {preferences.policy.languages.join(', ') || 'All known languages'}.</p>{:else}<PreferencesForm bind:preferences bind:rootLabel />{/if}
                    <label><input type="checkbox" bind:checked={confirmed} />Start this limited run now, keeping at least 50 GiB in reserve.</label>
                    <button disabled={!confirmed || busy} onclick={start}>Start Downloads</button><button onclick={() => setup = false}>Close without starting</button>
                </div>
            {/if}
        {/if}
        {#if view.message}<p role="status">{view.message}</p>{/if}
        {#if view.error}<p role="alert">{view.error}</p>{/if}
        {#each rows as row, index (JSON.stringify([row.seq, 'enqueueVersion' in row ? row.enqueueVersion : 0]))}
            <article data-testid="personal-entry">
                <div class="card-overview"><div class="identity">{#if !selections}<SavedCover seq={row.seq} state={'detailsState' in row ? `${row.detailsState}:${row.detailsRevision}` : undefined} />{/if}<div><h3 dir="auto">{row.title}</h3><p dir="auto">{row.siteName}</p>{#if 'historyCount' in row && row.historyCount}<MangaInfoEditor seq={row.seq} onchanged={() => action(async () => {})} />{/if}{#if 'state' in row}<strong>{row.state}</strong><progress max={row.progress?.selected || row.progress?.registered || 1} value={row.progress?.verified ?? 0} aria-label="Verified registered chapters"></progress>{/if}</div></div>
                {#if 'state' in row}<dl class="stats"><div><dt>Available Chapters (observed)</dt><dd>{available(row) ?? 'Unknown'}</dd></div><div><dt>Selected</dt><dd>{selectedCount(row) ?? 'Unknown'}</dd></div><div><dt>Completed (verified)</dt><dd>{row.progress?.verified ?? 0}</dd></div><div><dt>Downloading</dt><dd dir="auto">{row.progress?.chapter ?? '—'}</dd></div><div><dt>Failed</dt><dd>{row.progress?.failed ?? 0}</dd></div><div><dt>Partial / Review</dt><dd>{row.progress?.review ?? row.existing?.review ?? 0}</dd></div><div><dt>Pending</dt><dd>{row.progress?.pending ?? 'Unknown'}</dd></div></dl>{/if}</div>
                {#if missing[index]}<p class="warning">This reference is missing from the current catalog. Your selection is retained; the catalog may be incomplete.</p>{/if}
                {#if selections}
                    <button disabled={busy} onclick={() => action(() => queue.Select(row, false))}>Remove selection</button>
                    <button disabled={busy} onclick={() => action(() => queue.Add(row))}>Add to Queue</button>
                {:else if 'state' in row}
                    {#if row.existing}<p class="existing">{row.existing.healthy ? 'Existing verified chapters found' : 'Previous files checked'}: {row.existing.healthy} healthy · {row.existing.missing} missing · {row.existing.review} need review.</p>{/if}
                    {#if row.reason && ['Failed','Review','Paused','Interrupted'].includes(row.state)}<p class="reason" role={['Failed','Review'].includes(row.state) ? 'alert' : 'status'}>{row.reason}</p>{/if}
                    {#if row.detailsState}<p>Additional details: {row.detailsState}</p>{/if}
                    <QueueChapters {row} running={view.summary?.state === 'Running' || busy} onedit={work => action(work, true)} />
                    {#if row.progress?.storage}<p role="alert">Storage stopped: {row.progress.storage}. Completed files are safe. Resolve the storage issue before resuming.</p>{/if}
                    <div class="task-actions">
                        <button disabled={busy} onclick={() => action(async () => OpenHubManga(row))}>Open Manga</button><button disabled={busy || !row.historyCount} title={!row.historyCount ? 'No saved session yet' : 'Open the saved manga folder'} onclick={() => action(() => new ArchiveClient().Request<void>({ operation: 'queue-open-folder', seq: row.seq }))}>Open Folder</button>
                        <button disabled={busy || !row.historyCount || view.summary?.state === 'Running'} title={view.summary?.state === 'Running' ? 'Pause Downloads before checking files' : 'Check saved files without downloading'} onclick={() => action(async () => { await queue.Audit(row.seq); })}>Check files</button>
                        <button disabled={busy || view.summary?.state === 'Running' || page * 50 + index === 0} title={view.summary?.state === 'Running' ? 'Pause Downloads to reorder' : 'Move earlier in the queue'} onclick={() => action(() => queue.Edit(row.seq, 'up'))}>Move up</button>
                        <button disabled={busy || view.summary?.state === 'Running' || page * 50 + index >= (view.summary?.queued ?? 0) - 1} title={view.summary?.state === 'Running' ? 'Pause Downloads to reorder' : 'Move later in the queue'} onclick={() => action(() => queue.Edit(row.seq, 'down'))}>Move down</button>
                        <button disabled={busy || ['Preparing','Downloading'].includes(row.state)} title={['Preparing','Downloading'].includes(row.state) ? 'Pause the active task before removing it' : 'Remove from this list; saved files and history are retained'} onclick={() => action(() => queue.Edit(row.seq, 'remove'))}>Remove from downloads</button>
                    </div>
                    <details class="task-details"><summary>Details</summary><p dir="auto">Source ID: <bdi>{row.mangaId}</bdi></p><p>{row.reason}</p>
                    {#if view.summary?.batchId && !row.inCurrentRun && ['Queued','Paused'].includes(row.state)}<p>Waiting for a later run confirmation.</p>{/if}
                    {#if row.reason.includes('unknown-order')}<p class="warning">Chapter order is unverified. This item needs review before downloading.</p>{/if}
                    {#if row.progress}<p>Verified chapters: {row.progress.verified}/{row.progress.registered} • Verified data: {row.progress.bytes} bytes{row.progress.chapter ? ` • Current chapter: ${row.progress.chapter}` : ''}</p>{/if}
                    <p>Scope: {row.scope.mode} · {row.scope.order ?? 'source'}. Source completeness remains unproven.</p>
                    {#if !row.sessionId}
                        <label>Chapter scope <select disabled={busy || view.summary?.state === 'Running'} value={row.scope.mode} onchange={event => action(() => scope(row, event.currentTarget.value as 'all' | 'missing' | 'range'))}>
                            <option value="all">{QueueScopeLabels.all}</option><option value="missing">{QueueScopeLabels.missing}</option><option value="range">{QueueScopeLabels.range}</option>
                        </select></label>
                        {#if row.scope.mode === 'range'}
                            <label>From <input type="number" min="1" value={row.scope.from} disabled={busy} onchange={event => action(() => queue.Edit(row.seq, 'up', { mode: 'range', from: Number(event.currentTarget.value), to: row.scope.mode === 'range' ? row.scope.to : 1 }))} /></label>
                            <label>To <input type="number" min="1" value={row.scope.to} disabled={busy} onchange={event => action(() => queue.Edit(row.seq, 'up', { mode: 'range', from: row.scope.mode === 'range' ? row.scope.from : 1, to: Number(event.currentTarget.value) }))} /></label>
                        {/if}
                    {/if}
                    {#if row.historyCount}<DownloadReport seq={row.seq} scope={row.scope} disabled={busy || view.summary?.state === 'Running' || !row.sessionId} onretry={scope => action(() => queue.Supplement(row.seq, scope), true)} />{/if}
                    </details>
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
    summary { cursor:pointer; color:var(--cds-text-02); font-size:.8rem; } details { margin:.5rem 0; }
    .task-actions { display:flex;flex-wrap:wrap;align-items:center;gap:.35rem;margin:.7rem 0; } .task-actions button { margin:0; } .task-details { border-top:1px solid var(--cds-ui-03);padding-top:.6rem; }
    .card-overview { display:grid; grid-template-columns:minmax(0,1fr) minmax(20rem,1fr); gap:1rem; } .identity { display:flex; align-items:start; gap:.75rem; } .identity>div { min-width:0; } .stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.55rem; font-size:.78rem; } dt { color:var(--cds-text-02); } dd { margin:.25rem 0; overflow-wrap:anywhere; } progress { display:block; width:100%; height:.4rem; margin-top:.5rem; } .reason,.existing { font-size:.8rem; } @media(max-width:850px) { .card-overview { grid-template-columns:1fr; } }
</style>
