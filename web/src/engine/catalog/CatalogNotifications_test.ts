import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotifyCatalogChange } from './CatalogNotifications';

describe('Committed catalog notifications', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('Should retain publication success when an advisory notification is unavailable', () => {
        vi.stubGlobal('window', {});
        vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('Unavailable'); } });
        expect(() => NotifyCatalogChange('source')).not.toThrow();
        const close = vi.fn();
        vi.stubGlobal('BroadcastChannel', class {
            // eslint-disable-next-line @typescript-eslint/naming-convention -- Preserve the browser API name in this test double.
            postMessage = () => { throw new Error('Unavailable'); };
            close = close;
        });
        expect(() => NotifyCatalogChange('source')).not.toThrow(); expect(close).toHaveBeenCalledOnce();
    });
});
