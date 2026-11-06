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
    mangalover: 'بلاغ مستخدم: نجاح وفشل مختلط في صور بعض الفصول؛ السبب غير محسوم.',
    mangatek: 'بلاغ مستخدم: فشل استخراج مصدر الصور في العينة الأخيرة.',
    mangaspark: 'بلاغ مستخدم: عينات متعددة تعمل؛ لا يثبت سلامة جميع الأعمال.',
    azoraworld: 'بلاغ مستخدم: بعض الفصول بلا صفحات وأخرى تعمل.',
    'on-manga': 'بلاغ مستخدم: رفض وصول عند جلب القائمة.',
    mangastarz: 'بلاغ مستخدم: مهلة عند جلب القائمة.',
    mangalek: 'بلاغ مستخدم: مهلة عند جلب القائمة.',
    nijitranslations: 'بلاغ مستخدم: مهلة عند جلب القائمة.',
    shqqaa: 'بلاغ مستخدم: عينات من القائمة بلا فصول.',
};
export function SiteObservation(id: string): { label: string; recordedAt: string | null } {
    const label = Object.hasOwn(observations, id) ? observations[id] : undefined;
    return { label: label ?? 'لا تتوفر نتيجة فحص حي في المركز.', recordedAt: label ? '2026-11-06' : null };
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
