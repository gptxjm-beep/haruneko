<script lang="ts">
    import { ArchiveClient } from '../../../../engine/archive/ArchiveClient';
    import { ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import type { MangaInfoDraft } from '../../../../../../app/electron/src/archive/MangaInfoEditor';
    let { seq, onchanged }: { seq: number; onchanged?: () => Promise<void> } = $props();
    const client = new ArchiveClient();
    let opened = $state(false), busy = $state(false), draft: MangaInfoDraft = $state(), error = $state(''), notice = $state(''), cover: Uint8Array = $state(), confirmed = $state(false);
    const fields = ['Alternate titles', 'Description', 'Genres', 'Status', 'Type', 'Author', 'Artist'];
    async function load() { busy = true; error = ''; try { draft = await client.Request({ operation: 'queue-info-read', seq }); opened = true; cover = undefined; confirmed = false; } catch(cause) { error = ArchiveUIError(cause); } finally { busy = false; } }
    async function save(regenerate = false) {
        busy = true; error = ''; notice = '';
        try { if (regenerate) draft = await client.Request({ operation: 'queue-info-read', seq }); await client.Request({ operation: 'queue-info-save', seq, draft, cover: regenerate ? undefined : cover, confirmed }); notice = 'Saved. Reopen the local manga page to see changes.'; opened = false; await onchanged?.(); } catch(cause) { error = ArchiveUIError(cause); } finally { busy = false; }
    }
</script>
<button disabled={busy} onclick={load}>Edit Manga Info</button>
{#if error}<p role="alert">{error}</p>{/if}{#if notice}<p role="status">{notice}</p>{/if}
{#if opened && draft}<section class="editor" data-testid="manga-info-editor" aria-label="Edit Manga Info"><h3>Edit Manga Info</h3>{#if draft.warning}<p role="alert">{draft.warning}</p>{/if}
    <label>Title<input maxlength="4096" bind:value={draft.metadata.title} /></label>
    <div class="fields">{#each fields as field}<label>{field}{#if field === 'Description'}<textarea rows="5" maxlength="20000" bind:value={draft.metadata.fields[field]}></textarea>{:else}<input maxlength="20000" bind:value={draft.metadata.fields[field]} />{/if}</label>{/each}</div>
    <button disabled={busy} onclick={async () => { try { cover = await client.Request({ operation: 'queue-info-cover' }); } catch(cause) { error = ArchiveUIError(cause); } }}>Choose Cover…</button>{#if cover}<span>New cover selected</span>{/if}
    <label class="confirm"><input type="checkbox" bind:checked={confirmed} />Save changes and keep backups of existing information files</label>
    <button disabled={busy || !confirmed} onclick={() => save()}>Save Manga Info</button><button disabled={busy || !confirmed} onclick={() => save(true)}>Regenerate from saved JSON</button><button disabled={busy} onclick={load}>Reload files</button><button disabled={busy} onclick={() => opened = false}>Close</button>
</section>{/if}
<style>.editor{background:var(--cds-ui-background);padding:1rem;border:1px solid var(--cds-ui-03);margin:.8rem 0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem}label{display:grid;gap:.35rem;margin:.5rem 0;font-size:.8rem}input,textarea,button{background:var(--cds-field-01);color:var(--cds-text-01);border:1px solid var(--cds-ui-03);padding:.5rem;min-width:0}button{margin:.25rem;cursor:pointer}.confirm{display:flex;align-items:center;gap:.5rem}[role=alert]{color:var(--cds-support-warning)}@media(max-width:650px){.fields{grid-template-columns:1fr}}</style>
