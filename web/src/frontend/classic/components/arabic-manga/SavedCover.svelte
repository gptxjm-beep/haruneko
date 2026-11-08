<script lang="ts">
    import { onDestroy } from 'svelte';
    import { ArchiveClient } from '../../../../engine/archive/ArchiveClient';
    let { seq, state: savedState }: { seq: number; state?: string } = $props();
    let url = $state(''), serial = 0;
    $effect(() => {
        savedState; const current = ++serial;
        void new ArchiveClient().Request<{ bytes: Uint8Array; extension: string } | null>({ operation: 'queue-cover', seq }).then(result => {
            if (current !== serial) return;
            if (url) URL.revokeObjectURL(url);
            url = result ? URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.extension === 'jpg' ? 'image/jpeg' : `image/${result.extension}` })) : '';
        }).catch(() => {});
    });
    onDestroy(() => { serial++; if (url) URL.revokeObjectURL(url); });
</script>
{#if url}<img src={url} alt="Saved manga cover" />{:else}<div class="placeholder" aria-label="No saved cover">▤</div>{/if}
<style>img,.placeholder { width:64px; height:90px; object-fit:contain; border-radius:3px; background:var(--cds-ui-background); } .placeholder { display:grid; place-items:center; font-size:2rem; color:var(--cds-text-02); }</style>
