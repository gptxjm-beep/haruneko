(async () => {
    await import('/@id/carbon-components-svelte/css/all.css');
    await import('/src/frontend/classic/theme/hakuneko.css');
    await import('/src/frontend/classic/theme/global.css');
    document.documentElement.setAttribute('theme', 'hakuneko');
    const { mount, unmount, tick } = await import('/@id/svelte');
    const { SettingsManager } = await import('/src/engine/SettingsManager.ts');
    const { Initialize } = await import('/src/engine/SettingsGlobal.ts');
    const { MangaScraper, Manga, Chapter, Page } = await import('/src/engine/providers/MangaPlugin.ts');
    const { DownloadManager } = await import('/src/engine/DownloadManager.ts');
    const { Tags } = await import('/src/engine/Tags.ts');
    const { ArchiveClient } = await import('/src/engine/archive/ArchiveClient.ts');
    const { GetArchiveUIController } = await import('/src/engine/archive/ArchiveUIController.ts');
    const checks = [];
    const record = (name, passed) => { if (!passed) throw new Error(name); checks.push({ name, passed }); console.log(name, passed); };
    const wait = async (predicate, label) => { const end = Date.now() + 15000; while (!await predicate()) { if (Date.now() > end) throw new Error(`Timeout: ${label}; ${document.body.innerText.slice(-2000)}`); await new Promise(resolve => setTimeout(resolve, 40)); } };
    const click = async text => { const element = [...document.querySelectorAll('button,a')].find(element => element.textContent.trim() === text && element.checkVisibility()); if (!element) throw new Error(`Missing visible action ${text}`); element.click(); await tick(); };
    const { StorageControllerBrowser } = await import('/src/engine/StorageControllerBrowser.ts');
    const { Store } = await import('/src/engine/StorageController.ts');
    const browserStorage = new StorageControllerBrowser();
    const persistent = new Map(); const temporary = new Map();
    const storage = { SavePersistent: async (value, store, id) => store === Store.Settings ? browserStorage.SavePersistent(value, store, id) : persistent.set(`${store}:${id}`, value), LoadPersistent: async (store, id) => store === Store.Settings ? browserStorage.LoadPersistent(store, id) : persistent.get(`${store}:${id}`),
        SaveTemporary: async data => { const id = crypto.randomUUID(); temporary.set(id, data); return id; }, LoadTemporary: async id => temporary.get(id), RemoveTemporary: async (...keys) => keys.forEach(key => temporary.delete(key)) };
    const settings = new SettingsManager(storage);
    await Initialize(settings, []);
    const canvas = new OffscreenCanvas(2, 2); canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const image = await canvas.convertToBlob({ type: 'image/png' });
    let fetched = 0; let release;
    let gate = new Promise(resolve => { release = resolve; });
    class FixtureScraper extends MangaScraper {
        GetArchiveChapterOrder() { return { order: 'ascending', evidence: 'Isolated single-chapter fixture' }; }
        constructor(id, title) { super(id, title, 'https://isolated.invalid/', Tags.Media.Comic, Tags.Language.Arabic); }
        async Initialize() { /* Isolated fixture: no connector window or network is used. */ }
        async FetchMangas(site) { return [new Manga(this, site, 'manga', 'UI Manga')]; }
        async FetchChapters(manga) { return [new Chapter(this, manga, 'chapter', 'Chapter 1')]; }
        async FetchPages(chapter) { return [new Page(this, chapter, new URL('https://isolated.invalid/image'))]; }
        async FetchImage() { fetched++; await gate; return image; }
    }
    const site = new FixtureScraper('ui-site-a', 'UI Site A').CreatePlugin(storage, settings);
    const other = new FixtureScraper('ui-site-b', 'UI Site B').CreatePlugin(storage, settings);
    const downloads = new DownloadManager(storage);
    globalThis.HakuNeko = { SettingsManager: settings, DownloadManager: downloads, PluginController: { WebsitePlugins: [site, other], InfoTrackers: [] }, BookmarkPlugin: { GetEntriesWithUnflaggedContent: async () => [] } };
    const classic = await import('/src/frontend/classic/stores/Settings.svelte.ts'); await classic.Initialize();
    const { Store: UI } = await import('/src/frontend/classic/stores/Stores.svelte.ts');
    const { default: Sidenav } = await import('/src/frontend/classic/components/Sidenav.svelte');
    const { default: SettingsModal } = await import('/src/frontend/classic/components/settings/SettingsModal.svelte');
    const client = new ArchiveClient(); const controller = GetArchiveUIController();
    const target = document.createElement('main'); document.body.append(target);
    let sidebar = mount(Sidenav, { target, props: { isOpen: true, onHome() {} } });
    UI.selectedPlugin = undefined;
    await click('Archive Site');
    await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('Select a supported'), 'missing source message');
    record('Classic Archive Site reports a missing source without creating a session', !(await controller.Sessions()).some(session => session.siteId === site.Identifier));
    await unmount(sidebar); target.replaceChildren();
    UI.selectedPlugin = site;
    sidebar = mount(Sidenav, { target, props: { isOpen: true, onHome() {} } });
    await click('Archive Site');
    await wait(() => document.querySelector('[data-testid="archive-selected-site"]'), 'archive setup');
    record('Archive setup captures the selected website', document.querySelector('[data-testid="archive-selected-site"]').textContent === 'UI Site A');
    UI.selectedPlugin = other; await tick();
    record('Later selection changes do not retarget an open setup', document.querySelector('[data-testid="archive-selected-site"]').textContent === 'UI Site A');
    await click('Choose archive folder…');
    await wait(() => document.querySelector('[data-testid="archive-root-label"]').textContent !== 'No folder selected', 'native picker grant');
    record('Native picker displays a folder label without exposing a path', !document.querySelector('[data-testid="archive-root-label"]').textContent.includes('/'));
    const check = [...document.querySelectorAll('label')].find(label => label.textContent.includes('I confirm')).querySelector('input');
    record('Creation requires explicit confirmation', [...document.querySelectorAll('button')].find(button => button.textContent === 'Create archive session').disabled);
    check.click(); await tick(); await click('Create archive session');
    await wait(() => document.querySelector('[data-testid="archive-state"]')?.textContent === 'Paused', 'prepared session');
    const session = (await controller.Sessions()).find(session => session.siteId === site.Identifier);
    record('Creation persists a paused session without fetching images', !!session && fetched === 0);
    await click('Start');
    await wait(() => fetched === 1, 'first image request');
    await click('Refresh saved progress'); await tick();
    record('Progress refresh does not enqueue another attempt', (await controller.Progress(session.id)).snapshot.chaptersStarted === 1 && fetched === 1);
    await unmount(sidebar); target.replaceChildren();
    record('Closing the view leaves the owned archive manager running', controller.IsRunning(session.id));
    const monitor = mount(SettingsModal, { target, props: { isSettingsModalOpen: true, selectedTab: 4 } });
    await wait(() => document.querySelector('[data-testid="archive-state"]')?.textContent === 'Running', 'reopen live monitor');
    record('The fifth settings tab retains the original tabs and shows Archiving', [...document.querySelectorAll('[role="tab"]')].map(node => node.textContent.trim()).join(',') === 'General,Interface,Viewer,Trackers,Archiving');
    // Graceful pause waits for the current chapter receipt; it never cancels manual tasks.
    await click('Pause');
    record('Cancel remains available while a graceful pause waits for its chapter', [...document.querySelectorAll('button')].some(button => button.checkVisibility() && button.textContent === 'Cancel' && !button.disabled));
    release();
    await wait(async () => (await controller.Progress(session.id)).snapshot.state === 'paused', 'graceful pause');
    await click('Refresh saved progress');
    await wait(() => document.querySelector('[data-testid="archive-state"]')?.textContent === 'Paused', 'paused monitor');
    await click('Resume');
    await wait(() => !controller.IsRunning(session.id), 'resume');
    record('Resume verifies and reuses the saved output without a second fetch', fetched === 1 && (await controller.Progress(session.id)).verifiedChapters === 1);
    await click('Refresh saved progress');
    await wait(() => document.querySelector('[data-testid="archive-state"]')?.textContent !== 'Running', 'updated status');
    record('Uncertain source completeness never appears as Completed', !document.querySelector('[data-testid="archive-progress"]').textContent.includes('Completed'));
    await click('Choose archive folder…');
    await wait(() => document.querySelector('[data-testid="archive-root-label"]').textContent !== 'No folder selected', 'settings folder grant');
    const delay = [...document.querySelectorAll('label')].find(label => label.textContent.startsWith('Delay between requests')).querySelector('input');
    delay.value = '2000'; delay.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(); await click('Save archiving defaults');
    await wait(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('defaults saved')), 'settings saved');
    const next = (await controller.Preferences()).preferences;
    record('Archiving defaults persist without changing a saved session policy', (await controller.Preferences()).preferences.policy.delayMs === 2000 && (await controller.Progress(session.id)).snapshot.policy.delayMs === 1000);
    const id = await controller.Create(other, next, true);
    await ipcRenderer.invoke('ArchiveStorageTest::Capacity', 'low');
    await controller.Start(id); await wait(() => !controller.IsRunning(id), 'storage pause');
    await unmount(monitor); target.replaceChildren();
    const { default: Sessions } = await import('/src/frontend/classic/components/archiving/ArchiveSessions.svelte');
    const view = mount(Sessions, { target, props: { initialSession: id } });
    await wait(() => document.querySelector('[data-testid="archive-storage-error"]'), 'storage error display');
    record('Storage errors show a recoverable reason and required bytes', document.querySelector('[data-testid="archive-storage-error"]').textContent.includes('low-space') && document.querySelector('[data-testid="archive-storage-error"]').textContent.includes('Required bytes'));
    record('A storage pause offers Resume even before the first chapter attempt', [...document.querySelectorAll('button')].some(button => button.checkVisibility() && button.textContent === 'Resume'));
    await ipcRenderer.invoke('ArchiveStorageTest::Capacity', 'ample');
    await click('Cancel');
    await wait(async () => (await controller.Progress(id)).snapshot.state === 'cancelled', 'cancelled monitor');
    record('Cancel changes only the chosen archive session and preserves prior verified output', (await controller.Progress(id)).snapshot.state === 'cancelled' && (await controller.Progress(session.id)).verifiedChapters === 1);
    await unmount(view); target.replaceChildren();
    const finalSettings = mount(SettingsModal, { target, props: { isSettingsModalOpen: true, selectedTab: 4 } });
    await wait(() => document.querySelector('[data-testid="archive-progress"]'), 'final settings monitor');
    globalThis.archiveUIFixture = { id: session.id, rootId: next.rootId };
    await unmount(finalSettings); target.remove();
    return checks;
})()
