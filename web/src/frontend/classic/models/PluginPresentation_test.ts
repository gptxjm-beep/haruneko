import { describe, expect, it } from 'vitest';
import { Tags, Tag } from '../../../engine/Tags';
import { SettingsManager, Text } from '../../../engine/SettingsManager';
import { Store, type StorageController } from '../../../engine/StorageController';
import { FrontendResourceKey as R } from '../../../i18n/ILocale';
import type { MediaContainer, MediaChild } from '../../../engine/providers/MediaPlugin';
import { SupportsArabic, IsMultilingual, OrderPlugins, FilterHubSites, SiteObservation, OpenPlugin, CreateArabicFirstSetting, ArabicFirstKey, type ClassicNavigation } from './PluginPresentation';

const plugin = (id: string, title: string, ...tags: Tag[]) => ({ Identifier: id, Title: title, Tags: { Value: tags }, URI: new URL(`https://${id}.invalid/`) });
const arabic = plugin('arabic', 'Z English name', Tags.Language.Arabic);
const english = plugin('english', 'A موقع عربي بالاسم', Tags.Language.English);
const multi = plugin('multi', 'B Multilingual', Tags.Language.Multilingual);
const both = plugin('both', 'C Both', Tags.Language.Arabic, Tags.Language.Multilingual);

describe('Classic plugin presentation without network or Svelte', () => {
    it('Should require the Arabic language tag and accept equivalent tag instances', () => {
        expect(SupportsArabic(arabic)).toBe(true);
        expect(SupportsArabic(english)).toBe(false);
        expect(SupportsArabic(multi)).toBe(false);
        expect(SupportsArabic(both) && IsMultilingual(both)).toBe(true);
        expect(SupportsArabic(plugin('clone', 'Clone', new Tag(Tags.Language.Arabic.Category, Tags.Language.Arabic.Title)))).toBe(true);
    });
    it('Should prioritize declared Arabic while preserving all sites and not mutating the input', () => {
        const input = [english, arabic, multi, both];
        expect(OrderPlugins(input, true)).toEqual([both, arabic, english, multi]);
        expect(input).toEqual([english, arabic, multi, both]);
    });
    it('Should restore the legacy alphabetical comparator and preserve favorite priority within groups', () => {
        const input = [arabic, multi, both, english];
        expect(OrderPlugins(input, false)).toEqual([english, multi, both, arabic]);
        expect(OrderPlugins(input, false, ['arabic'])).toEqual([arabic, english, multi, both]);
        expect(OrderPlugins(input, true, ['english', 'arabic'])).toEqual([arabic, both, english, multi]);
    });
    it('Should use stable identifiers to break equal-title ties', () => {
        expect(OrderPlugins([plugin('z', 'Same'), plugin('a', 'Same')], true).map(value => value.Identifier)).toEqual(['a', 'z']);
    });
    it('Should filter Arabic sites by title, ID or host, without leaking multilingual-only entries into the default scope', () => {
        const input = [english, arabic, multi, both];
        expect(FilterHubSites(input, '')).toEqual([both, arabic]);
        expect(FilterHubSites(input, ' Z ENGLISH ')).toEqual([arabic]);
        expect(FilterHubSites(input, 'both.invalid')).toEqual([both]);
        expect(FilterHubSites(input, 'arabic')).toEqual([arabic]);
        expect(FilterHubSites(input, 'no-match')).toEqual([]);
        expect(FilterHubSites(input, '', 'multilingual-unconfirmed')).toEqual([multi]);
    });
    it('Should distinguish dated user observations from unavailable live health', () => {
        expect(SiteObservation('mangatek')).toMatchObject({ recordedAt: '2026-11-06' });
        expect(SiteObservation('mangaspark').label).toContain('not a site-wide');
        expect(SiteObservation('constructor').recordedAt).toBeNull();
        expect(SiteObservation('__proto__').recordedAt).toBeNull();
        expect(SiteObservation('unexamined')).toEqual({ recordedAt: null, label: 'No live health check is available in this hub.' });
    });
    it('Should open the native plugin and clear incompatible media without fetching or touching archive state', () => {
        const previous = english as unknown as MediaContainer<MediaChild>;
        const state: ClassicNavigation = { page: 'arabic-manga', selectedPlugin: previous, selectedMedia: previous, selectedItem: previous };
        OpenPlugin(state, arabic as unknown as MediaContainer<MediaChild>);
        expect(state).toEqual({ page: 'media', selectedPlugin: arabic, selectedMedia: undefined, selectedItem: undefined });
    });
    it('Should preserve the selection when reopening the same plugin', () => {
        const current = arabic as unknown as MediaContainer<MediaChild>;
        const state: ClassicNavigation = { page: 'arabic-manga', selectedPlugin: current, selectedMedia: current, selectedItem: current };
        OpenPlugin(state, current);
        expect(state.selectedMedia).toBe(current);
        expect(state.selectedItem).toBe(current);
        expect(state.page).toBe('media');
    });
    it('Should default to Arabic first and persist both changes across fresh settings managers without overwriting existing preferences', async () => {
        const records = new Map<string, unknown>();
        records.set(`${Store.Settings}:frontend.classic`, { theme: 'g100' });
        const storage = { LoadPersistent: async (store: Store, id: string) => structuredClone(records.get(`${store}:${id}`)),
            SavePersistent: async (value: unknown, store: Store, id: string) => { records.set(`${store}:${id}`, structuredClone(value)); } } as unknown as StorageController;
        const open = async () => {
            const scope = new SettingsManager(storage).OpenScope('frontend.classic');
            const setting = CreateArabicFirstSetting();
            const theme = new Text('theme', R.Frontend_Classic_Settings_Theme, R.Frontend_Classic_Settings_ThemeInfo, 'default');
            await scope.Initialize(setting, theme);
            return { setting, theme };
        };
        const first = await open();
        expect(first.setting.Value).toBe(true);
        first.setting.Value = false;
        const second = await open();
        expect(second.setting.ID).toBe(ArabicFirstKey);
        expect(second.setting.Value).toBe(false);
        expect(second.theme.Value).toBe('g100');
        second.setting.Value = true;
        expect((await open()).setting.Value).toBe(true);
    });
});
