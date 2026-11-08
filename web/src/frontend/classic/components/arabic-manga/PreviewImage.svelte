<script lang="ts">
    import { onMount } from 'svelte';
    import type { MediaItem } from '../../../../engine/providers/MediaPlugin';
    import Image from '../viewer/Image.svelte';
    let { page, index }: { page: MediaItem; index: number } = $props();
    let host: HTMLElement, visible = $state(false);
    onMount(() => {
        const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { visible = true; observer.disconnect(); } }, { rootMargin: '160px' });
        observer.observe(host); return () => observer.disconnect();
    });
</script>
<div class="page" bind:this={host} aria-label={`Page ${index + 1}`}>
    {#if visible}<Image {page} alt={`Page ${index + 1}`} wide={false} />{:else}<span>Page {index + 1}</span>{/if}
</div>
<style>.page{min-width:0;min-height:14rem;display:flex;align-items:center;justify-content:center;background:var(--cds-ui-01);border:1px solid var(--cds-ui-03);border-radius:6px;overflow:hidden}.page :global(.imgpreview){width:100%;height:auto;max-height:32rem;object-fit:contain;margin:auto}.page :global(img){display:block}.page :global(.bx--inline-loading){padding:1rem}span{color:var(--cds-text-02);font-size:.8rem}</style>
