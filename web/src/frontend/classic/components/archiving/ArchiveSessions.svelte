<script lang="ts">
    import { onMount } from 'svelte';
    import { GetArchiveUIController, ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import type { ArchiveUIProgress, ArchiveUISession } from '../../../../../../app/electron/src/archive/ArchiveUIContract';
    interface Props { initialSession?: string; }
    let { initialSession = '' }: Props = $props();
    let sessions = $state<ArchiveUISession[]>([]);
    let selected = $state(InitialSelection());
    function InitialSelection() { return initialSession; }
    let progress = $state<ArchiveUIProgress | null>(null);
    let error = $state('');
    let pending = $state<'' | 'start' | 'pause' | 'cancel'>('');
    let loading = false;
    let pageBefore = $state<number | undefined>(undefined);
    let mounted = true;
    async function Refresh() {
        if (loading) return;
        loading = true;
        try {
            const controller = GetArchiveUIController();
            const page = pageBefore;
            const list = await controller.Sessions(page);
            const id = selected || list[0]?.id || '';
            const current = id ? await controller.Progress(id) : null;
            if (mounted && page === pageBefore && id === (selected || list[0]?.id || '')) { sessions = list; selected = id; progress = current; }
        } catch(cause) { if (mounted) error = ArchiveUIError(cause); }
        finally { loading = false; }
    }
    async function Control(action: 'start' | 'pause' | 'cancel') {
        if (!selected || pending && (action !== 'cancel' || pending === 'cancel')) return;
        pending = action; error = '';
        try {
            const controller = GetArchiveUIController();
            if (action === 'start') await controller.Start(selected);
            else if (action === 'pause') await controller.Pause(selected);
            else await controller.Cancel(selected);
            await Refresh();
        } catch(cause) { error = ArchiveUIError(cause); }
        finally { if (pending === action) pending = ''; }
    }
    onMount(() => {
        mounted = true;
        void Refresh();
        const timer = setInterval(() => void Refresh(), 1500);
        return () => { mounted = false; clearInterval(timer); };
    });
</script>
<section aria-label="Archive sessions">
    <h4>Archive sessions</h4>
    <p>Opening or closing this view does not start or cancel a session. Sessions never resume automatically.</p>
    <label>Saved sessions (50 per page)
        <select bind:value={selected} onchange={() => { progress = null; void Refresh(); }}>
            {#each sessions as session}<option value={session.id}>{session.siteName} — {new Date(session.createdAt).toLocaleString()} — {session.snapshot.state}</option>{/each}
        </select>
    </label>
    <button type="button" onclick={Refresh}>Refresh saved progress</button>
    <button type="button" disabled={sessions.length < 50} onclick={() => { pageBefore = sessions.at(-1)?.cursor; selected = ''; progress = null; void Refresh(); }}>Older sessions</button>
    <button type="button" disabled={pageBefore === undefined} onclick={() => { pageBefore = undefined; selected = ''; progress = null; void Refresh(); }}>Latest sessions</button>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if progress}
        <div data-testid="archive-progress" aria-live="polite">
            <h4>{progress.siteName}</h4>
            <p><strong>Status: <span data-testid="archive-state">{progress.snapshot.state.charAt(0).toUpperCase() + progress.snapshot.state.slice(1)}</span></strong></p>
            <p>Folder: {progress.rootLabel} · {progress.format}</p>
            <p>Current manga: {progress.currentManga ?? '—'} · Current chapter: {progress.currentChapter ?? '—'}</p>
            <dl>
                <dt>Discovered manga</dt><dd>{progress.discoveredMangas}</dd>
                <dt>Registered chapters</dt><dd>{progress.registeredChapters}</dd>
                <dt>Saved chapters (last recorded verification)</dt><dd>{progress.verifiedChapters}</dd>
                <dt>Failed chapters</dt><dd>{progress.snapshot.counts.failed ?? 0}</dd>
                <dt>Chapters needing review</dt><dd>{progress.snapshot.counts.review ?? 0}</dd>
                <dt>Manga needing review</dt><dd>{progress.snapshot.counts['manga:review'] ?? 0}</dd>
                <dt>Verified output bytes recorded</dt><dd>{progress.writtenBytes.toLocaleString()}</dd>
                <dt>Cumulative manga / chapter attempts</dt><dd>{progress.snapshot.mangasUsed} / 5 · {progress.snapshot.chaptersStarted} / 20</dd>
            </dl>
            <p>Catalog: {progress.snapshot.catalogState}. Source completeness: <strong>{progress.snapshot.index.state}</strong>.</p>
            <p>{progress.snapshot.index.evidence || 'No evidence of a complete site index.'}</p>
            <p>{progress.snapshot.reason}</p>
            {#if progress.snapshot.storageError}
                <div role="alert" data-testid="archive-storage-error">
                    Storage stop: {progress.snapshot.storageError.code} ({progress.snapshot.storageError.location}).
                    Required bytes: {progress.snapshot.storageError.requiredBytes ?? 'unknown'};
                    available bytes: {progress.snapshot.storageError.usableBytes ?? 'unknown'};
                    reserve bytes: {progress.snapshot.storageError.reserveBytes ?? 'unknown'}.
                    Free space or reconnect the original destination, then Resume. Files are preserved.
                </div>
            {/if}
        </div>
        <div class="controls">
            <button type="button" disabled={!!pending || progress.snapshot.state === 'running' || progress.snapshot.state === 'cancelled'} onclick={() => Control('start')}>{progress.snapshot.reason === 'Prepared; awaiting Start' ? 'Start' : 'Resume'}</button>
            <button type="button" disabled={!!pending || progress.snapshot.state !== 'running'} onclick={() => Control('pause')}>Pause</button>
            <button type="button" disabled={pending === 'cancel' || progress.snapshot.state === 'cancelled'} onclick={() => Control('cancel')}>Cancel</button>
            {#if pending}<span role="status">Waiting for a safe transition…</span>{/if}
        </div>
        <details><summary>Recent events and errors (up to 100 each)</summary>
            <ul>{#each progress.events as event}<li>{event.kind}: {event.reason}</li>{/each}</ul>
            <ul>{#each progress.errors as failure}<li>{failure.stage}: {failure.message}</li>{/each}</ul>
        </details>
    {:else if !error}<p>No saved session selected.</p>{/if}
</section>
<style>
    section { display: grid; gap: 0.8rem; padding: 1rem 0; }
    select { width: 100%; }
    button, select { color: var(--cds-text-01); background: var(--cds-field-01); padding: 0.5rem; border: 1px solid var(--cds-border-strong); }
    button:disabled { opacity: 0.5; }
    dl { display: grid; grid-template-columns: 2fr 1fr; gap: 0.4rem; }
    .controls { display: flex; gap: 0.8rem; align-items: center; }
    li { padding: 0.25rem; overflow-wrap: anywhere; }
</style>
