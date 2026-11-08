import { MangaPlugin } from '../../../engine/providers/MangaPlugin';
import { Store as UI } from '../stores/Stores.svelte';
import type { MangaReference } from '../../../../../app/electron/src/archive/SelectiveQueueContract';
export function OpenHubManga(ref: MangaReference): void {
    const site = HakuNeko.PluginController.WebsitePlugins.find(plugin => plugin.Identifier === ref.siteId);
    if (!(site instanceof MangaPlugin)) throw new Error('Manga connector unavailable');
    UI.selectedPlugin = site; UI.selectedMedia = site.CreateEntry(ref.mangaId, ref.title); UI.selectedItem = undefined; UI.page = 'media';
}
