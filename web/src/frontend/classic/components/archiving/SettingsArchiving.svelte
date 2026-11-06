<script lang="ts">
    import { onMount } from 'svelte';
    import { GetArchiveUIController, ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import type { ArchivePreferences } from '../../../../../../app/electron/src/archive/ArchiveUIContract';
    import ArchivePreferencesForm from './ArchivePreferencesForm.svelte';
    import ArchiveSessions from './ArchiveSessions.svelte';
    let preferences = $state<ArchivePreferences | null>(null);
    let rootLabel = $state('No folder selected');
    let error = $state('');
    let message = $state('');
    let busy = $state(false);
    onMount(() => { void (async () => {
        try { const saved = await GetArchiveUIController().Preferences(); preferences = structuredClone(saved.preferences); rootLabel = saved.rootLabel; }
        catch(cause) { error = ArchiveUIError(cause); }
    })(); });
    async function Save() {
        if (!preferences || busy) return;
        busy = true; error = ''; message = '';
        try {
            const saved = await GetArchiveUIController().Client.Request<ArchivePreferences>({ operation: 'ui-save-preferences', preferences: $state.snapshot(preferences) });
            preferences = saved; message = 'Archiving defaults saved. Existing session policies are unchanged.';
        } catch(cause) { error = ArchiveUIError(cause); }
        finally { busy = false; }
    }
</script>
<h3>Archiving</h3>
{#if error}<p role="alert">{error}</p>{/if}
{#if message}<p role="status">{message}</p>{/if}
{#if preferences}
    <ArchivePreferencesForm bind:preferences bind:rootLabel allowReserve />
    <button type="button" disabled={busy} onclick={Save}>Save archiving defaults</button>
    <ArchiveSessions />
{/if}
