import { app, BrowserWindow, nativeTheme, net, protocol, screen, session, shell } from 'electron';
import { join, normalize, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonSync, writeFileAtomicSync } from './fsutil';
import { dataDir, rendererDir } from './paths';

export const APP_SCHEME = 'gatehouse';
export const APP_ORIGIN = `${APP_SCHEME}://app`;
const DEV_URL = !app.isPackaged ? process.env.GATEHOUSE_DEV_URL : undefined;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function isTrustedUrl(url: string): boolean {
  return url.startsWith(`${APP_ORIGIN}/`) || (!!DEV_URL && url.startsWith(DEV_URL));
}

/** Must run before the app is ready. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

export function serveRenderer() {
  const root = rendererDir();
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !extname(rel)) rel = '/index.html';
    const full = normalize(join(root, rel));
    if (!full.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(full).toString());
    const headers = new Headers(res.headers);
    if (rel.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function statePath() {
  return join(dataDir(), 'window-state.json');
}

function loadState(): WindowState {
  const s = readJsonSync<WindowState>(statePath());
  const fallback = { width: 1320, height: 860 };
  if (!s || typeof s.width !== 'number') return fallback;
  if (typeof s.x === 'number' && typeof s.y === 'number') {
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x! < b.x + b.width - 80 && s.x! + s.width > b.x + 80 && s.y! >= b.y - 20 && s.y! < b.y + b.height - 80;
    });
    if (!visible) return { width: s.width, height: s.height };
  }
  return s;
}

export function createMainWindow(): BrowserWindow {
  const state = loadState();
  const mac = process.platform === 'darwin';
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    title: 'Gatehouse',
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 18, y: 18 } : undefined,
    vibrancy: mac ? 'sidebar' : undefined,
    visualEffectState: mac ? 'followWindow' : undefined,
    backgroundColor: mac ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1c1c1f' : '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  if (state.maximized) win.maximize();

  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  const save = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    writeFileAtomicSync(statePath(), JSON.stringify({ ...b, maximized: win.isMaximized() }), 0o600);
  };
  win.on('resized', save);
  win.on('moved', save);
  win.on('close', save);

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}
