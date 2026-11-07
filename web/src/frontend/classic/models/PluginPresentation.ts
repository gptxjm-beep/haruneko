import { Tags, type Tag } from '../../../engine/Tags';
import { Check } from '../../../engine/SettingsManager';
import { FrontendResourceKey as R } from '../../../i18n/ILocale';
import type { MediaContainer, MediaChild } from '../../../engine/providers/MediaPlugin';

export interface PluginSummary {
    readonly Identifier: string;
    readonly Title: string;
    readonly Tags: { readonly Value: readonly Tag[] };
    readonly URI: URL;
}
const HasTag = (plugin: PluginSummary, tag: Tag) => plugin.Tags.Value.some(value => value.Category === tag.Category && value.Title === tag.Title);
export const SupportsArabic = (plugin: PluginSummary) => HasTag(plugin, Tags.Language.Arabic);
export const IsMultilingual = (plugin: PluginSummary) => HasTag(plugin, Tags.Language.Multilingual);
export const ArabicFirstKey = 'arabic-first-plugins';
export const CreateArabicFirstSetting = () => new Check(ArabicFirstKey, R.Frontend_Classic_Settings_ArabicFirst, R.Frontend_Classic_Settings_ArabicFirstInfo, true);

/** Return a copy; keep favorite priority within each language group and retain the legacy comparator when disabled. */
export function OrderPlugins<T extends PluginSummary>(plugins: readonly T[], arabicFirst: boolean, favorites: readonly string[] = []): T[] {
    return plugins.toSorted((a, b) => (arabicFirst ? Number(SupportsArabic(b)) - Number(SupportsArabic(a)) : 0)
        || Number(favorites.includes(b.Identifier)) - Number(favorites.includes(a.Identifier))
        || a.Title.localeCompare(b.Title) || a.Identifier.localeCompare(b.Identifier));
}

export type SiteScope = 'arabic' | 'multilingual-unconfirmed';
export function FilterHubSites<T extends PluginSummary>(plugins: readonly T[], query: string, scope: SiteScope = 'arabic'): T[] {
    const text = query.trim().normalize('NFKC').toLocaleLowerCase();
    return OrderPlugins(plugins.filter(plugin => (scope === 'arabic' ? SupportsArabic(plugin) : IsMultilingual(plugin) && !SupportsArabic(plugin))
        && [plugin.Title, plugin.Identifier, plugin.URI.hostname].some(value => value.normalize('NFKC').toLocaleLowerCase().includes(text))), false);
}

/** User observations, never a live health certificate. No requests or inference from a connector's name. */
const observations: Record<string, string> = {
    mangalover: 'User report: mixed chapter image results; cause unconfirmed.',
    mangatek: 'User report: image source extraction failed in the latest sample.',
    mangaspark: 'User report: several working samples; not a site-wide health check.',
    azoraworld: 'User report: some chapters have no pages; others work.',
    'on-manga': 'User report: catalog access denied.',
    mangastarz: 'User report: catalog request timed out.',
    mangalek: 'User report: catalog request timed out.',
    nijitranslations: 'User report: catalog request timed out.',
    shqqaa: 'User report: sampled manga have no chapters.',
};
export function SiteObservation(id: string): { label: string; recordedAt: string | null } {
    const label = Object.hasOwn(observations, id) ? observations[id] : undefined;
    return { label: label ?? 'No live health check is available in this hub.', recordedAt: label ? '2026-11-06' : null };
}

export interface ClassicNavigation {
    page: 'media' | 'arabic-manga';
    selectedPlugin: MediaContainer<MediaChild>;
    selectedMedia: MediaContainer<MediaChild>;
    selectedItem: MediaContainer<MediaChild>;
}
/** Opening a site selects the native plugin; it never fetches, queues or changes archive ownership. */
export function OpenPlugin(state: ClassicNavigation, plugin: MediaContainer<MediaChild>): void {
    if (state.selectedPlugin?.Identifier !== plugin.Identifier) {
        state.selectedMedia = undefined;
        state.selectedItem = undefined;
    }
    state.selectedPlugin = plugin;
    state.page = 'media';
}
