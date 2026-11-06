import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApplicationWindow } from './ApplicationWindow';
const state = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', () => ({ BrowserWindow: class {
    destroyed = false;
    callbacks = new Map<string, () => void>();
    shown = vi.fn();
    show() { this.shown(); if (this.destroyed) throw new Error('Object has been destroyed'); }
    constructor() { state.windows.push(this); }
    on(event: string, callback: () => void) { this.callbacks.set(event, callback); }
    isDestroyed() { return this.destroyed; }
    removeMenu() {}
    setMenu() {}
    setMenuBarVisibility() {}
    async loadURL() {}
} }));
beforeEach(() => { state.windows.length = 0; });
describe('Application splash shutdown', () => {
    it('Should show a live main window when its splash closes', async () => {
        const main = new ApplicationWindow();
        await main['OpenSplash']('http://localhost/splash');
        state.windows[1].callbacks.get('closed')();
        expect(state.windows[0].shown).toHaveBeenCalledOnce();
    });
    it('Should not show a destroyed main window during early application shutdown', async () => {
        const main = new ApplicationWindow();
        await main['OpenSplash']('http://localhost/splash');
        state.windows[0].destroyed = true;
        expect(() => state.windows[1].callbacks.get('closed')()).not.toThrow();
        expect(state.windows[0].shown).not.toHaveBeenCalled();
    });
});
