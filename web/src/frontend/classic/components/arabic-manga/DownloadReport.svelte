<script lang="ts">
    import { ArchiveClient } from '../../../../engine/archive/ArchiveClient';
    import { ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import type { QueueScope } from '../../../../../../app/electron/src/archive/SelectiveQueueContract';
    let { seq, scope, onretry, disabled = false }: { seq: number; scope: QueueScope; onretry: (scope: QueueScope) => Promise<void>; disabled?: boolean } = $props();
    let confirmRetry = $state(false);
    let report = $state<any>(), opened = $state(false), busy = $state(false), error = $state('');
    const failed = $derived(report?.sessions?.[0]?.chapters?.filter(chapter => chapter.state === 'failed').map(chapter => chapter.id) ?? []);
    const client = new ArchiveClient();
    async function show() { opened = !opened; if (!opened) return; busy = true; try { report = await client.Request({ operation: 'queue-report', seq }); } catch(cause) { error = ArchiveUIError(cause); } finally { busy = false; } }
</script>
<button onclick={show} disabled={busy}>Download Report</button>
{#if opened}<section class="report" data-testid="download-report" aria-label="Download report">
    <h3>Download Report</h3>{#if error}<p role="alert">{error}</p>{/if}
    {#if report}<p dir="auto">{report.title} · {report.site}</p><p>Generated {report.generatedAt}. Source completeness unproven. Additional details: {report.details}.</p>
        <button onclick={async () => { try { await client.Request({ operation: 'queue-export-report', seq }); } catch(cause) { error = ArchiveUIError(cause); } }}>Export JSON…</button>
        {#if failed.length && !report.sessions[0].truncated}<button disabled={disabled || busy} onclick={() => confirmRetry = !confirmRetry}>Retry failed chapters…</button>{/if}
        {#if confirmRetry}<p>Create a linked supplementary selection for {failed.length} failed chapters? Healthy files and cumulative limits are preserved. Start Downloads remains explicit.</p><button disabled={disabled || busy} onclick={async () => { busy = true; try { await onretry({ ...scope, mode: 'selected', ids: failed }); confirmRetry = false; opened = false; } catch(cause) { error = ArchiveUIError(cause); } finally { busy = false; } }}>Confirm supplementary retry</button>{/if}
        {#each report.sessions as session (session.id)}<details open><summary>{session.state} · {session.counts.completed}/{session.counts.requested} verified requested chapters</summary>
            <p>{session.reason}</p><p>Failed: {session.counts.failed} · Partial / Review: {session.counts.review} · Pending: {session.counts.pending}</p>
            {#each session.chapters as chapter}<p dir="auto"><strong>{chapter.title}</strong> — {chapter.state} / {chapter.localState}: {chapter.reason}</p>{#each chapter.errors as issue}<small>{issue.stage}: {issue.message}</small>{/each}<details><summary>Attempt timings and write / cleanup results</summary><pre>{JSON.stringify(chapter.attempts, null, 2)}</pre></details>{/each}
            {#if session.truncated}<p>Preview limited to 1000 registered chapters. Counts cover the whole saved session.</p>{/if}
            <details><summary>Recorded history ({session.history.length})</summary><pre>{JSON.stringify(session.history, null, 2)}</pre></details>
        </details>{/each}
    {/if}
</section>{/if}
<style>
    .report { padding:.7rem; border:1px solid var(--cds-ui-03); margin:.5rem 0; max-height:32rem; overflow:auto; } p { font-size:.85rem; margin:.5rem 0; } small { display:block; color:var(--cds-text-02); } pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:.75rem; } button { color:var(--cds-text-01); background:var(--cds-field-01); border:1px solid var(--cds-ui-03); padding:.4rem; margin:.2rem; } summary { cursor:pointer; }
</style>
