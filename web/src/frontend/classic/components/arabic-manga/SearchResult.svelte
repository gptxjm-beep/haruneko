<script lang="ts">
    import { Button } from 'carbon-components-svelte';
    import type { SearchRow } from '../../../../engine/search/LocalSearch';
    let { row, disabled = false, onopen }: { row: SearchRow; disabled?: boolean; onopen: (row: SearchRow) => void } = $props();
</script>
<article data-testid="shared-search-result" data-site-id={row.siteId} data-manga-id={row.mangaId}>
    <div><h3 dir="auto">{row.title}</h3><p dir="auto">هوية المصدر: <bdi>{row.mangaId}</bdi></p></div>
    <Button kind="secondary" size="small" {disabled} onclick={() => onopen(row)}>فتح المانجا في مصدرها</Button>
</article>
<style>
    article { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; padding: 1rem; border-bottom: 1px solid var(--cds-ui-03); }
    article > div { min-width: 0; flex: 1 1 15rem; } h3 { font-size: 1.1rem; overflow-wrap: anywhere; } p { overflow-wrap: anywhere; font-size: .8rem; color: var(--cds-text-02); margin-top: .5rem; }
</style>
