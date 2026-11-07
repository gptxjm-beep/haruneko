<script lang="ts">
    import { Button } from 'carbon-components-svelte';
    import type { SearchRow } from '../../../../engine/search/LocalSearch';
    let { row, disabled = false, onopen, selected = false, queued = false, onselect, onadd, queueSupported = false }: { row: SearchRow; disabled?: boolean; onopen: (row: SearchRow) => void; selected?: boolean; queued?: boolean; onselect?: (row: SearchRow, selected: boolean) => void; onadd?: (row: SearchRow) => void; queueSupported?: boolean } = $props();
</script>
<article data-testid="shared-search-result" data-site-id={row.siteId} data-manga-id={row.mangaId}>
    <label><input type="checkbox" aria-label={`Select ${row.title}`} checked={selected} disabled={!queueSupported} onchange={event => onselect?.(row, event.currentTarget.checked)} />Select (separate from favorites)</label>
    <div><h3 dir="auto">{row.title}</h3><details><summary>Source details</summary><p dir="auto">Source ID: <bdi>{row.mangaId}</bdi></p></details></div>
    {#if queued}<p>Added to downloads</p>{/if}
    <Button kind="secondary" size="small" {disabled} onclick={() => onopen(row)}>Open manga</Button>
    <Button kind="secondary" size="small" disabled={!queueSupported} onclick={() => onadd?.(row)}>Add to Queue</Button>
</article>
<style>
    article { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .6rem; padding: .65rem .8rem; border-bottom: 1px solid var(--cds-ui-03); }
    article > div { min-width: 0; flex: 1 1 15rem; } h3 { font-size: 1rem; overflow-wrap: anywhere; } p { overflow-wrap: anywhere; font-size: .8rem; color: var(--cds-text-02); margin-top: .5rem; }
    label { font-size:.75rem; display:flex; align-items:center; gap:.4rem; } article > p { color:var(--cds-support-success); }
    summary { font-size:.75rem; color:var(--cds-text-02); cursor:pointer; margin-top:.35rem; }
</style>
