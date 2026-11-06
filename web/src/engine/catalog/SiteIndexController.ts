import { MangaPlugin } from '../providers/MangaPlugin';
import { EngineArchiveSource } from '../archive/ArchiveSource';
import { Tags } from '../Tags';
import { SiteIndexRepository } from './SiteIndexRepository';
import { SiteIndexManager } from './SiteIndexManager';
import type { IndexSiteState, IndexJob } from './SiteIndexContract';

export const IndexStateLabel: Record<IndexSiteState, string> = { queued: 'في الانتظار', updating: 'جارٍ التحديث', succeeded: 'نجح تحديث الفهرس',
    failed: 'فشل التحديث', stale: 'فهرس قديم محفوظ', cancelled: 'أُلغي', review: 'يحتاج مراجعة' };
export const IndexJobStateLabel: Record<IndexJob['state'], string> = { running: 'جارٍ التحديث', paused: 'متوقف مؤقتًا', interrupted: 'انقطع دون إنهاء طبيعي', cancelled: 'أُلغي', finished: 'انتهت معالجة المواقع المحددة' };
export function IndexErrorLabel(code: string): string {
    if (code.startsWith('catalog-needs-review')) return 'نتيجة فارغة أو جزئية أو متعارضة تحتاج مراجعة؛ الفهرس السابق محفوظ.';
    if (code.startsWith('catalog-conflict')) return 'تغيّر الفهرس أو حالة العملية أثناء الجلب؛ لم تُنشر النتيجة القديمة.';
    if (code.startsWith('catalog-timeout')) return 'انتهت مهلة جلب القائمة؛ لم تُنشر نتيجة متأخرة.';
    if (code.startsWith('catalog-storage')) return 'تعذر حفظ الفهرس؛ بقيت آخر قائمة مقبولة.';
    if (code.startsWith('catalog-access')) return 'تعذر الوصول أو أن قدرة الفهرسة غير متاحة؛ لا نحاول تجاوز الحماية.';
    if (code.startsWith('catalog-interrupted') || code.startsWith('interrupted:')) return 'انقطعت محاولة سابقة؛ يلزم استئناف صريح ضمن ميزانية المحاولات المحفوظة.';
    return 'تعذر جلب قائمة الموقع أو قراءتها؛ احتُفظ بالفهرس السابق إن وُجد.';
}
export function ArabicCatalogSources(sites: readonly unknown[]) {
    return sites.filter((site): site is MangaPlugin => site instanceof MangaPlugin && site.Tags.Value.some(tag => tag.Category === Tags.Language.Arabic.Category && tag.Title === Tags.Language.Arabic.Title))
        .map(site => ({ id: site.Identifier, Catalog: (signal: AbortSignal) => new EngineArchiveSource(site).Catalog(signal), Published: () => site.InvalidateMediaListCache() }));
}
let controller: SiteIndexManager | undefined;
export function GetSiteIndexController(): SiteIndexManager {
    return controller ??= new SiteIndexManager(new SiteIndexRepository(), () => ArabicCatalogSources(HakuNeko.PluginController.WebsitePlugins), navigator.locks);
}
