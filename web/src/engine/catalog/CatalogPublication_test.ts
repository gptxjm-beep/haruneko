import { describe, expect, it } from 'vitest';
import { MergeCatalogObservation } from './CatalogPublication';
describe('Non-destructive search catalog publication', () => {
    it('Should save partial observations and retain every absent old identity', () => {
        const previous = Array.from({ length: 399 }, (_, n) => ({ id: String(n), title: `Original ${n}` }));
        const update = MergeCatalogObservation(previous, [{ id: '0', title: 'Updated' }, { id: 'new', title: 'New' }], { state: 'partial', evidence: 'Partial fixture' });
        expect(update.entries).toHaveLength(400); expect(update.entries.find(row => row.id === '398')!.title).toBe('Original 398');
        expect(update.coverage.state).toBe('partial');
    });
    it('Should accept useful unknown coverage without inventing completeness and reject unproven empty data', () => {
        expect(MergeCatalogObservation([], [{ id: 'a', title: 'A' }], { state: 'unknown', evidence: 'Fixture' }).coverage.state).toBe('unknown');
        expect(() => MergeCatalogObservation([{ id: 'a', title: 'A' }], [], { state: 'unknown', evidence: '' })).toThrow();
    });
});
