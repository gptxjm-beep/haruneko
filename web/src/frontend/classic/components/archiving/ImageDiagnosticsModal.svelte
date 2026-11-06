<script lang="ts">
    import { onDestroy } from 'svelte';
    import { Modal } from 'carbon-components-svelte';
    import { Chapter } from '../../../../engine/providers/MangaPlugin';
    import { DiagnoseChapterImage, type ImageDiagnosticReport } from '../../../../engine/ImageDiagnostics';
    interface Props { open: boolean; chapter: unknown; }
    let { open = $bindable(), chapter }: Props = $props();
    const selected = Capture();
    function Capture() { return chapter; }
    let position = $state(1);
    let report = $state<ImageDiagnosticReport | null>(null);
    let build = $state('');
    let busy = $state(false);
    let notice = $state('');
    let cancellation: AbortController | undefined;
    onDestroy(() => cancellation?.abort());
    async function Probe() {
        if (busy || !(selected instanceof Chapter)) return;
        busy = true; notice = ''; report = null; cancellation = new AbortController();
        try {
            const info = await globalThis.ipcRenderer.invoke('Preview::Info');
            build = info.commit;
            report = await DiagnoseChapterImage(selected, position, cancellation.signal);
        } catch { notice = 'Diagnostics unavailable. Use the complete Electron Preview bundle.'; }
        finally { busy = false; }
    }
    async function Copy() {
        if (!report) return;
        try {
            await navigator.clipboard.writeText(JSON.stringify({ build, ...$state.snapshot(report) }, null, 2));
            notice = 'Safe diagnostic JSON copied. It contains no image URL, cookies or account headers.';
        } catch { notice = 'Clipboard unavailable. Select and copy the displayed JSON report manually.'; }
    }
</script>
<Modal bind:open passiveModal modalHeading="Image Diagnostics — Preview" size="lg">
    <p>Optional single-image test. Extracts the selected chapter's page list, then requests only the numbered image. Nothing is downloaded automatically or saved to an archive.</p>
    <p>Reports keep only the connector/chapter labels, image hostname, HTTP status, MIME, signature category, byte count, dimensions and failure stage. No full links, query strings, account headers or response text are retained.</p>
    {#if selected instanceof Chapter}
        <label>Image position (1 = first image) <input type="number" min="1" step="1" bind:value={position} disabled={busy} /></label>
        <button type="button" onclick={Probe} disabled={busy || !Number.isSafeInteger(position) || position < 1}>Test one image</button>
        <button type="button" onclick={() => cancellation?.abort()} disabled={!busy}>Cancel test</button>
    {:else}<p role="alert">Select a manga chapter first, then reopen Image Diagnostics.</p>{/if}
    {#if busy}<p role="status">Testing one image… Cancellation prevents a subsequent image request; chapter-list extraction may need to finish.</p>{/if}
    {#if report}
        <pre data-testid="image-diagnostic-report">{JSON.stringify({ build, ...$state.snapshot(report) }, null, 2)}</pre>
        <button type="button" onclick={Copy}>Copy safe report</button>
    {/if}
    {#if notice}<p role="status">{notice}</p>{/if}
</Modal>
<style>
    p { margin: 0.8rem 0; }
    button, input { padding: 0.5rem; margin: 0.5rem; color: var(--cds-text-01); background: var(--cds-field-01); border: 1px solid var(--cds-ui-04); }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 1rem; background: var(--cds-ui-02); }
</style>
