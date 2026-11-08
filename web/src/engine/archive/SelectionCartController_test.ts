import { describe, it, expect } from 'vitest';
import { CartPartial, CartSelectedCount } from './SelectionCartController';
import type { CartSelection } from '../../../../app/electron/src/archive/SelectionCartContract';
describe('Cart checkbox states', () => {
    it('Should distinguish unknown All, known zero, partial and full without treating zero as partial', () => {
        const item = (value: Partial<CartSelection>) => ({ mode: 'all', ids: [], order: 'source', ...value }) as CartSelection;
        expect(CartSelectedCount(item({}))).toBeUndefined(); expect(CartPartial(item({}))).toBe(false);
        for (const value of [{ mode: 'selected' as const, ids: [], chapterCount: 1 }, { mode: 'except' as const, ids: ['1'], chapterCount: 1 }]) {
            expect(CartSelectedCount(item(value))).toBe(0); expect(CartPartial(item(value))).toBe(false);
        }
        expect(CartPartial(item({ mode: 'selected', ids: ['1'], chapterCount: 1 }))).toBe(false);
        expect(CartPartial(item({ mode: 'selected', ids: ['1', '2'], chapterCount: 10 }))).toBe(true);
    });
});
