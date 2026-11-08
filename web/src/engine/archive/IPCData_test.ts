import { describe, expect, it } from 'vitest';
import { IPCData } from './IPCData';
describe('Archive IPC DTO boundary', () => {
    it('Should unwrap nested reactive proxies while preserving selected identities and binary chunks', () => {
        const scope = new Proxy({ mode: 'selected', ids: new Proxy(['one', 'two'], {}) }, {});
        expect(() => structuredClone(scope)).toThrow();
        expect(structuredClone(IPCData(scope))).toEqual({ mode: 'selected', ids: ['one', 'two'] });
        const bytes = new Uint8Array([1, 2]); expect(IPCData({ bytes }).bytes).toBe(bytes);
    });
    it('Should refuse callbacks, live handles and cycles', () => {
        expect(() => IPCData({ callback: () => {} })).toThrow();
        expect(() => IPCData(new Date())).toThrow();
        const cycle: any = {}; cycle.self = cycle; expect(() => IPCData(cycle)).toThrow();
    });
});
