<script lang="ts">
    import { onDestroy } from 'svelte';
    import type { Chapter, Page } from '../../../../engine/providers/MangaPlugin';
    import { ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import PreviewImage from './PreviewImage.svelte';
    let { chapter }: { chapter: Chapter } = $props();
    let pages: readonly Page[] = $state([]), loading = $state(true), error = $state(''), active = true;
    onDestroy(() => active = false);
    async function load() {
        try { if (!chapter.Entries.Value.length) await chapter.Update(); if (active) pages = chapter.Entries.Value; }
        catch(cause) { if (active) error = ArchiveUIError(cause); } finally { if (active) loading = false; }
    }
    void load();
</script>
<div class="preview-scroll" data-testid="chapter-preview" aria-label="Chapter Preview">
    {#if loading}<p role="status">Loading pages…</p>{:else if error}<p role="alert">{error}</p>{:else if !pages.length}<p>No pages returned.</p>{:else}
    <div class="pages">{#each pages as page, index (index)}<PreviewImage {page} {index} />{/each}</div>{/if}
</div>
<style>.preview-scroll{overflow:auto;min-height:0;flex:1;padding:.65rem}.pages{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem}p{color:var(--cds-text-02);font-size:.85rem;padding:1rem}[role=alert]{color:var(--cds-support-warning)}</style>
