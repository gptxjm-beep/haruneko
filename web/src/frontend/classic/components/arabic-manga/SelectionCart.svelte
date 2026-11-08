<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { GetSelectionCart, CartCount, CartSelectedCount } from '../../../../engine/archive/SelectionCartController';
    import { Store as UI } from '../../stores/Stores.svelte';
    import { ArchiveUIError } from '../../../../engine/archive/ArchiveUIController';
    import { GetLocalSearchController } from '../../../../engine/search/LocalSearchController';
    import { ArchiveClient } from '../../../../engine/archive/ArchiveClient';
    let { onopen }: { onopen?: (ref: any) => void } = $props();
    const cart = GetSelectionCart(); let view = $state(cart.State.Value), busy = $state(false), error = $state(''), confirm = $state<number | 'all'>();
    const observe = value => { view = value; }; cart.State.Subscribe(observe); onDestroy(() => cart.State.Unsubscribe(observe));
    onMount(() => { void cart.Refresh().catch(cause => error = ArchiveUIError(cause)); });
    let supplement = $state<number>();
    let page = $state(0), missing = $state<string[]>([]); let inspect = 0;
    $effect(() => { const items = view.items.slice(page * 50, page * 50 + 50), token = ++inspect; void GetLocalSearchController().Client.Contains(items).then(found => { if (token === inspect) missing = items.filter((_, index) => !found[index]).map(item => `${item.siteId}:${item.mangaId}`); }).catch(() => {}); });
    let known = $derived(view.items.reduce((sum, item) => sum + (CartSelectedCount(item) ?? 0), 0));
    let unknown = $derived(view.items.some(item => CartSelectedCount(item) === undefined));
    let groups = $derived([...new Set(view.items.slice(page * 50, page * 50 + 50).map(item => item.siteId))]);
    async function action(work: () => Promise<void>) { busy = true; error = ''; try { await work(); } catch(cause) { error = ArchiveUIError(cause); } finally { busy = false; } }
    function open(ref) { UI.explorerReference = ref; UI.hubSection = 'explorer'; onopen?.(ref); }
</script>
<section data-testid="selection-cart" aria-label="Selection Cart">
    <header><h2>Selection Cart ({view.items.length})</h2><button disabled={busy || !view.items.length} onclick={() => action(() => cart.Transfer())}>Add Selected to Downloads</button><button onclick={() => UI.hubSection = 'queue'}>Downloads</button><button disabled={busy || !view.items.length} onclick={() => confirm = 'all'}>Clear cart</button></header>
    <p>Selected chapters: {known}{unknown ? ' + Unknown' : ''}</p>
    {#if error}<p role="alert">{error}</p>{/if}{#if view.message}<p role="status">{view.message}</p>{/if}
    {#if confirm !== undefined}<p role="alert">Remove {confirm === 'all' ? 'all selections' : 'this manga and its chapter selection'}?</p><button disabled={busy} onclick={() => action(async () => { if (confirm === 'all') await new ArchiveClient().Request({ operation: 'cart-clear', confirmed: true }); else { const item = view.items.find(item => item.seq === confirm); if (item) await cart.Select(item, false, true); } confirm = undefined; await cart.Refresh(); })}>Confirm removal</button><button onclick={() => confirm = undefined}>Keep selections</button>{/if}
    {#each groups as id (id)}<details open><summary dir="auto">{view.items.find(item => item.siteId === id)?.siteName} ({view.items.filter(item => item.siteId === id).length})</summary>
        {#each view.items.slice(page * 50, page * 50 + 50).filter(item => item.siteId === id) as item (item.seq)}<article data-testid="personal-entry"><button class="name" dir="auto" onclick={() => open(item)}>{item.title}</button><span>{CartCount(item)} chapters</span>{#if item.reason}<small role="alert">{item.reason}</small><button disabled={busy} onclick={() => supplement = item.seq}>Supplement Downloads…</button>{/if}{#if missing.includes(`${item.siteId}:${item.mangaId}`)}<small>This reference is missing from the current catalog</small>{/if}<button disabled={busy} onclick={() => confirm = item.seq}>Remove</button></article>{/each}
    </details>{/each}
    {#if supplement !== undefined}<p role="alert">Use this cart scope for a supplementary download task? Saved manifests and files are retained. Pause Downloads first; starting remains explicit.</p><button disabled={busy} onclick={() => action(async () => { const item = view.items.find(item => item.seq === supplement); if (item) await cart.Supplement(item); supplement = undefined; })}>Confirm supplementary transfer</button><button onclick={() => supplement = undefined}>Keep in cart</button>{/if}
    {#if !view.items.length}<p>Your cart is empty.</p>{/if}
    <footer><button disabled={page === 0} onclick={() => page--}>Previous</button><span>{page + 1}</span><button disabled={(page + 1) * 50 >= view.items.length} onclick={() => page++}>Next</button></footer>
</section>
<style>section{border-radius:6px;padding:.5rem}header,article,footer{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}header{justify-content:flex-start;padding-bottom:.6rem;border-bottom:1px solid var(--cds-ui-03)}h2{font-size:1rem;margin-right:auto}article{padding:.6rem .25rem;border-bottom:1px solid var(--cds-ui-03)}article:last-child{border-bottom:0}article>span{font-size:.75rem;padding:.2rem .5rem;border-radius:1rem;background:var(--cds-field-01);color:var(--cds-text-02)}button{background:var(--cds-field-01);color:var(--cds-text-01);border:1px solid var(--cds-ui-03);border-radius:3px;padding:.4rem .6rem;cursor:pointer;font-size:.8rem}button:disabled{opacity:.45;cursor:default}.name{flex:1 1 12rem;text-align:start;overflow-wrap:anywhere;border:0;background:transparent;font-weight:500}details{margin:.7rem 0;padding:.6rem .8rem;background:var(--cds-ui-01);border:1px solid var(--cds-ui-03);border-left:3px solid var(--cds-interactive-01);border-radius:4px}summary{cursor:pointer;font-weight:600;font-size:.85rem}footer{justify-content:center;margin:.6rem}p,small{margin:.6rem 0;font-size:.8rem;color:var(--cds-text-02)}[role=alert]{color:var(--cds-support-warning)}</style>
