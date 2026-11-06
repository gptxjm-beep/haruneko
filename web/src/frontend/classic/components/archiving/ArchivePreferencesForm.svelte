<script lang="ts">
    import { ArchiveFormats, type ArchivePreferences } from '../../../../../../app/electron/src/archive/ArchiveUIContract';
    import { GetArchiveUIController, ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    interface Props { preferences: ArchivePreferences; rootLabel: string; allowReserve?: boolean; }
    let { preferences = $bindable(), rootLabel = $bindable(), allowReserve = false }: Props = $props();
    let error = $state('');
    let choosing = $state(false);
    async function Choose() {
        choosing = true; error = '';
        try {
            const selection = await GetArchiveUIController().Client.Request<{ rootId: string; label: string } | null>({ operation: 'choose-root' });
            if (selection) { preferences.rootId = selection.rootId; rootLabel = selection.label; }
        } catch(cause) { error = ArchiveUIError(cause); }
        finally { choosing = false; }
    }
</script>
<div class="archive-form">
    <p><strong>Archive folder:</strong> <span data-testid="archive-root-label">{rootLabel}</span></p>
    <button type="button" disabled={choosing} onclick={Choose}>Choose archive folder…</button>
    <label>Export format <select bind:value={preferences.format}>{#each Object.entries(ArchiveFormats) as [label, value]}<option {value}>{label}</option>{/each}</select></label>
    <label><input type="checkbox" bind:checked={preferences.useWebsiteSubDirectory} /> Create a separate website folder</label>
    <label>Languages (comma-separated codes; empty means all known languages)
        <input value={preferences.policy.languages.join(', ')} oninput={event => preferences.policy.languages = event.currentTarget.value.split(',').map(value => value.trim()).filter(Boolean)} placeholder="ar, en" />
    </label>
    <label>Chapters with unknown language <select bind:value={preferences.policy.unknownLanguage}><option value="review">Require review</option><option value="include">Include explicitly</option></select></label>
    <label>Delay between requests (ms) <input type="number" min="100" max="60000" step="100" bind:value={preferences.policy.delayMs} /></label>
    <label>Retry delay (ms) <input type="number" min="1000" max="60000" step="1000" bind:value={preferences.policy.retryDelayMs} /></label>
    <label>Maximum attempts per item <input type="number" min="1" max="3" bind:value={preferences.policy.maxAttempts} /></label>
    <label>Free-space reserve per volume (GiB) <input type="number" min="50" max="4096" disabled={!allowReserve} bind:value={preferences.reserveGiB} /></label>
    {#if allowReserve}<p>Minimum 50 GiB. To change the reserve, cancel open sessions first. Other defaults apply only to new sessions.</p>{/if}
    <p role="note"><strong>Experimental, limited trial:</strong> at most 5 manga and 20 chapter download attempts per session. Resume does not reset these budgets. Existing files are preserved. Index completeness is not assumed.</p>
    {#if error}<p role="alert">{error}</p>{/if}
</div>
<style>
    .archive-form { display: grid; gap: 0.8rem; padding: 0.8rem 0; }
    label { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    input, select, button { color: var(--cds-text-01); background: var(--cds-field-01); padding: 0.5rem; border: 1px solid var(--cds-border-strong); }
    input[type=number] { width: 8rem; }
    input[type=checkbox] { width: auto; }
</style>
