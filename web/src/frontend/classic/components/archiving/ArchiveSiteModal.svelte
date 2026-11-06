<script lang="ts">
    import { onMount } from 'svelte';
    import { Modal } from 'carbon-components-svelte';
    import { GetArchiveUIController, ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import type { ArchivePreferences } from '../../../../../../app/electron/src/archive/ArchiveUIContract';
    import ArchivePreferencesForm from './ArchivePreferencesForm.svelte';
    import ArchiveSessions from './ArchiveSessions.svelte';
    interface Props { open: boolean; site: unknown; }
    let { open = $bindable(), site }: Props = $props();
    // Capture the selected connector once. Later sidebar selection changes cannot retarget this setup.
    const chosenSite = CaptureSite();
    function CaptureSite() { return site; }
    let siteName = $state('');
    let preferences = $state<ArchivePreferences | null>(null);
    let rootLabel = $state('No folder selected');
    let error = $state('');
    let confirmed = $state(false);
    let busy = $state(false);
    let created = $state('');
    onMount(() => {
        void (async () => {
            try {
                const controller = GetArchiveUIController();
                if (!controller.Supported(chosenSite)) throw new Error('Select a supported manga website first. Bookmarks and non-manga sources are not supported.');
                siteName = chosenSite.Title;
                const saved = await controller.Preferences();
                preferences = structuredClone(saved.preferences); rootLabel = saved.rootLabel;
            } catch(cause) { error = ArchiveUIError(cause); }
        })();
    });
    async function Create() {
        if (!preferences || !confirmed || busy) return;
        busy = true; error = '';
        try { created = await GetArchiveUIController().Create(chosenSite, $state.snapshot(preferences), confirmed); }
        catch(cause) { error = ArchiveUIError(cause); }
        finally { busy = false; }
    }
</script>
<Modal bind:open passiveModal modalHeading="Archive Site" size="lg" hasForm>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if created}<ArchiveSessions initialSession={created} />
    {:else if preferences}
        <h4>Website: <span data-testid="archive-selected-site">{siteName}</span></h4>
        <ArchivePreferencesForm bind:preferences bind:rootLabel />
        <p>This trial uses the selected website, regardless of the selected manga or chapter. Follow the website's access rules; restricted content is not bypassed.</p>
        <label><input type="checkbox" bind:checked={confirmed} /> I confirm the selected website and folder for this limited trial (5 manga / 20 chapter attempts).</label>
        <button type="button" disabled={!confirmed || !preferences.rootId || busy} onclick={Create}>Create archive session</button>
        <p>Creating saves the setup only. Use Start in the session monitor to begin.</p>
    {/if}
</Modal>
