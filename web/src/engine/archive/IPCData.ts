/** IPC contracts contain DTOs and byte arrays, never UI reactive proxies or live handles. */
export function IPCData<T>(value: T, ancestors = new Set<object>()): T {
    if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (value instanceof Uint8Array) return value;
    if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Unsupported or cyclic IPC data');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) return value.map(item => IPCData(item, ancestors)) as T;
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Live objects cannot be sent to the archive service');
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, IPCData(item, ancestors)])) as T;
    } finally { ancestors.delete(value); }
}
