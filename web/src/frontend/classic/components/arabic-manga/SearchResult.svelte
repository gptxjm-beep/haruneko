<script lang="ts">
    import { Button } from 'carbon-components-svelte';
    import type { SearchRow } from '../../../../engine/search/LocalSearch';
    let { row, disabled = false, onopen, selected = false, queued = false, onselect, onadd, queueSupported = false }: { row: SearchRow; disabled?: boolean; onopen: (row: SearchRow) => void; selected?: boolean; queued?: boolean; onselect?: (row: SearchRow, selected: boolean) => void; onadd?: (row: SearchRow) => void; queueSupported?: boolean } = $props();
</script>
<article data-testid="shared-search-result" data-site-id={row.siteId} data-manga-id={row.mangaId}>
    <label><input type="checkbox" aria-label={`تحديد ${row.title}`} checked={selected} disabled={!queueSupported} onchange={event => onselect?.(row, event.currentTarget.checked)} />محدد مستقل عن المفضلة</label>
    <div><h3 dir="auto">{row.title}</h3><p dir="auto">هوية المصدر: <bdi>{row.mangaId}</bdi></p></div>
    {#if queued}<p>مضاف إلى القائمة؛ الحالة والتقدم في Download Queue.</p>{/if}
    <Button kind="secondary" size="small" {disabled} onclick={() => onopen(row)}>فتح المانجا في مصدرها</Button>
    <Button kind="secondary" size="small" disabled={!queueSupported} onclick={() => onadd?.(row)}>Add to Queue</Button>
</article>
<style>
    article { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; padding: 1rem; border-bottom: 1px solid var(--cds-ui-03); }
    article > div { min-width: 0; flex: 1 1 15rem; } h3 { font-size: 1.1rem; overflow-wrap: anywhere; } p { overflow-wrap: anywhere; font-size: .8rem; color: var(--cds-text-02); margin-top: .5rem; }
</style>
