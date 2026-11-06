import path from 'path';
import fs from 'fs/promises';
import { app, dialog, ipcMain } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { PreviewName, PreviewOrigin, PreviewDataDirectory, VerifyPreview, ServePreview } from './preview/PreviewRuntime';
import { AssertArchiveSender } from './archive/ArchiveIPC';
import { Command } from 'commander';
import { Logger } from './Logger';
import { IPC } from './ipc/InterProcessCommunication';
import { ApplicationWindow } from './ipc/ApplicationWindow';
import { FetchProvider } from './ipc/FetchProvider';
import { InitializeMenu } from './Menu';
import { BloatGuard } from './ipc/BloatGuard';
import { RemoteBrowserWindowController } from './ipc/RemoteBrowserWindow';
import { RPCServer } from '../../src/rpc/Server';
import { RemoteProcedureCallManager } from './ipc/RemoteProcedureCallManager';
import { RemoteProcedureCallContract } from './ipc/RemoteProcedureCallContract';
import { ArchiveIPC } from './archive/ArchiveIPC';
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

type CLIOptions = {
    origin?: string;
}

app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function ParseCLI(): CLIOptions {
    try {
        const argv = new Command()
            .allowUnknownOption(true)
            .allowExcessArguments(true)
            .option('--origin [url]', 'custom location from which the web-app shall be loaded')
            .parse(process.argv, { from: 'electron' });
        return argv.opts<CLIOptions>();
    } catch {
        return {};
    }
}

type Manifest = {
    url: string;
    enhancedPreview?: boolean;
    'user-agent': undefined | string;
    'user-data-dir': undefined | string;
};

async function LoadManifest(): Promise<Manifest> {
    const file = path.resolve(app.getAppPath(), 'package.json');
    const content = await fs.readFile(path.normalize(file), { encoding: 'utf-8' });
    return JSON.parse(content) as Manifest;
}

async function SetupUserDataDirectory(manifest: Manifest): Promise<void> {
    const userDataDir = manifest['user-data-dir'];
    // TODO: Do not replace when already set via commandline
    if(/* !argv['user-data-dir'] && */ userDataDir) {
        app.setPath('userData', path.isAbsolute(userDataDir) ? userDataDir : path.resolve(path.dirname(app.getPath('exe')), userDataDir));
    }
}

async function CreateApplicationWindow(): Promise<ApplicationWindow> {
    const win = new ApplicationWindow({
        show: false,
        width: 1280,
        height: 800,
        center: true,
        frame: false,
        transparent: true,
        //icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
        webPreferences: {
            sandbox: false,
            webSecurity: false, // Bypass CORS checks
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            disableBlinkFeatures: 'AutomationControlled',
            preload: path.resolve(app.getAppPath(), 'preload.js'),
        },
    });

    win.setMenuBarVisibility(false);
    win.on('closed', () => app.quit());

    return win;
}

function CheckHostPermission(url: string, appURI: URL) {
    try {
        return new URL(url).hostname === appURI.hostname;
    } catch {
        return false;
    }
}

function UpdatePermissions(session: Electron.Session, appURI: URL) {
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => CheckHostPermission(requestingOrigin, appURI));
    session.setPermissionRequestHandler((webContents, permission, callback, details) => callback(CheckHostPermission(details.requestingUrl, appURI)));
    // TODO: May remove the following workaround when https://github.com/electron/electron/issues/41957 is solved
    session.on('file-system-access-restricted', (event, details, callback) => callback(CheckHostPermission(details.origin, appURI) ? 'allow' : 'deny'));
}

async function OpenWindow(): Promise<void> {
    try {
        InitializeMenu();
        const argv = ParseCLI();
        const manifest = await LoadManifest();
        if (manifest.enhancedPreview) {
            app.setName(PreviewName);
            const directory = PreviewDataDirectory(app.getAppPath());
            for (const [key, leaf] of Object.entries({ userData: 'profile', sessionData: 'browser', temp: 'temp', logs: 'logs', crashDumps: 'crashes' })) {
                const target = path.join(directory, leaf); await fs.mkdir(target, { recursive: true });
                app.setPath(key as Parameters<typeof app.setPath>[0], target);
            }
            app.commandLine.removeSwitch('user-data-dir');
            app.commandLine.removeSwitch('disk-cache-dir');
            app.commandLine.appendSwitch('disk-cache-dir', path.join(directory, 'browser', 'Cache'));
            if (!app.requestSingleInstanceLock()) { app.quit(); return; }
            if (process.platform === 'win32') app.setAppUserModelId('org.haruneko.enhanced.preview');
        } else await SetupUserDataDirectory(manifest);
        app.userAgentFallback = manifest['user-agent'] ?? app.userAgentFallback.split(/\s+/).filter(segment => !/(hakuneko|electron)/i.test(segment)).join(' ');
        await app.whenReady();
        const win = await CreateApplicationWindow();
        let uri: URL;
        if (manifest.enhancedPreview) {
            const preview = await VerifyPreview(app.getAppPath());
            if (preview.electron !== process.versions.electron) throw new Error('Preview Electron version mismatch');
            const server = await ServePreview(app.getAppPath(), preview);
            app.once('will-quit', () => { server.closeAllConnections(); server.close(); });
            win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== PreviewOrigin) event.preventDefault(); });
            uri = new URL(PreviewOrigin); // CLI --origin cannot select a hosted or stale UI in Preview.
            await win.webContents.session.clearCache();
            await win.webContents.session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
            const database = new DatabaseSync(':memory:');
            const sqlite = String(database.prepare('SELECT sqlite_version() AS version').get()!.version); database.close();
            ipcMain.handle('Preview::Info', event => {
                AssertArchiveSender(event, win, PreviewOrigin);
                return { name: PreviewName, commit: preview.commit, dirty: preview.dirty, electron: process.versions.electron, sqlite, localUI: true };
            });
            win.on('page-title-updated', event => event.preventDefault());
            win.setTitle(`${PreviewName} — ${preview.commit.slice(0, 8)}`);
        } else uri = new URL(argv.origin ?? manifest.url ?? 'about:blank');
        new ArchiveIPC(win, uri.origin);
        UpdatePermissions(win.webContents.session, uri);

        new Logger(win.webContents);
        const ipc = new IPC(win.webContents);
        const rpc = new RPCServer('/hakuneko', new RemoteProcedureCallContract(ipc, win.webContents));
        new RemoteProcedureCallManager(rpc, ipc);
        new FetchProvider(ipc, win.webContents);
        new RemoteBrowserWindowController(ipc);
        new BloatGuard(ipc, win.webContents);
        win.RegisterChannels(ipc);
        await win.loadURL(uri.href).catch(error => console.warn(error));
    } catch(error) {
        if (app.getName() === PreviewName) {
            console.error('Preview startup failed');
            dialog.showErrorBox('Preview startup failed', 'Preview requires its complete local bundle and a writable isolated data folder; close other Preview windows and check the bundle.');
        } else console.error(error);
        app.quit();
    }
}

OpenWindow();
