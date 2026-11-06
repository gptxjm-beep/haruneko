/** Advisory only. Readers always validate revisions against IndexedDB; messages carry no catalog data. */
export function NotifyCatalogChange(siteId?: string): void {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    let channel: BroadcastChannel | undefined;
    try {
        channel = new BroadcastChannel('haruneko-catalog');
        channel.postMessage({ siteId });
    } catch { /* A notification failure must not turn an already committed catalog into a failed update. */ }
    finally { channel?.close(); }
}
