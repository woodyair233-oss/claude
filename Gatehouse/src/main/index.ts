import { app, BrowserWindow, dialog, nativeTheme, Notification, powerMonitor, systemPreferences } from 'electron';
import type { SnapshotPatch, Toast } from '../shared/types';
import { auditDir, bridgePath, configureUserData, endpointPath, fileExists, socketPath, storePath, vaultPath } from './paths';
import { Store, type StoreSlice } from './store';
import { Vault } from './vault';
import { PromptBroker } from './prompts';
import { ConnectionManager } from './ssh/connection';
import { TerminalManager } from './ssh/terminal';
import { SftpManager } from './ssh/sftp';
import { ForwardManager } from './ssh/forwards';
import { GatewayService } from './gateway/service';
import { McpSocketServer } from './gateway/socket-server';
import type { TouchIdProvider } from './gateway/approvals';
import { registerIpc } from './ipc';
import { createMainWindow, registerAppScheme, serveRenderer } from './window';
import { buildAppMenu, resolvedLanguage, TrayController } from './menu';
import type { AppContext } from './context';
import { clampSettings } from './validation';

configureUserData();
app.setName('Gatehouse');
registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let quitting = false;
let ctx: AppContext;
let tray: TrayController;
let socketServer: McpSocketServer | undefined;

const touchId: TouchIdProvider = {
  available: () => process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
  prompt: (reason) =>
    systemPreferences.promptTouchID(reason).then(
      () => true,
      () => false,
    ),
};

// --- Patch batching: coalesce state updates sent to the renderer ---------------
let pendingPatch: SnapshotPatch = {};
let patchTimer: NodeJS.Timeout | undefined;
function queuePatch(patch: () => SnapshotPatch) {
  Object.assign(pendingPatch, patch());
  if (patchTimer) return;
  patchTimer = setTimeout(() => {
    patchTimer = undefined;
    const p = pendingPatch;
    pendingPatch = {};
    mainWindow?.webContents.send('state:patch', p);
  }, 30);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): BrowserWindow {
  const win = createMainWindow();
  win.on('close', (e) => {
    if (!quitting && process.platform === 'darwin') {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function toast(t: Toast) {
  mainWindow?.webContents.send('app:toast', t);
}

function applySettings() {
  const s = ctx.store.settings;
  nativeTheme.themeSource = s.theme;
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] });
    } catch {
      /* unsigned builds may refuse */
    }
  }
  buildAppMenu(ctx);
  tray?.sync();
}

function updateBadge() {
  const pending = ctx.gateway.approvals.count;
  if (process.platform === 'darwin') app.dock?.setBadge(pending ? String(pending) : '');
  tray?.update();
}

async function boot() {
  serveRenderer();
  const store = new Store(storePath());
  clampSettings(store.settings);
  const vault = new Vault(vaultPath());
  await vault.init();
  const prompts = new PromptBroker();
  const pool = new ConnectionManager({ store, vault, prompts });
  const terminals = new TerminalManager(pool, {
    data: (id, data) => mainWindow?.webContents.send('term:data', id, data),
  });
  const sftp = new SftpManager(pool);
  const forwards = new ForwardManager(pool);
  const gateway = new GatewayService({
    store,
    vault,
    pool,
    sftp,
    touchId,
    appVersion: app.getVersion(),
    auditDir: auditDir(),
    bridgePath,
    bridgeExists: () => fileExists(bridgePath()),
  });
  await gateway.init();

  const ui = { locked: store.settings.security.lockOnLaunch && (touchId.available() || vault.status().passwordWrap) };
  ctx = {
    appVersion: app.getVersion(),
    store,
    vault,
    prompts,
    pool,
    terminals,
    sftp,
    forwards,
    gateway,
    touchId,
    window: () => mainWindow,
    showWindow,
    ui,
    setUiLocked: (locked) => {
      ui.locked = locked;
      queuePatch(() => ({ uiLocked: locked }));
    },
    toast,
    onSettingsChanged: applySettings,
  };

  registerIpc(ctx);
  tray = new TrayController(ctx);
  mainWindow = createWindow();
  applySettings();

  // --- Wire change events to renderer patches ---------------------------------
  store.on('change', (slice: StoreSlice) => {
    queuePatch(() => ({ [slice]: store.data[slice] }) as SnapshotPatch);
    if (slice === 'settings') {
      tray.update();
      buildAppMenu(ctx);
      queuePatch(() => ({ gateway: gateway.status() }));
    }
  });
  vault.on('change', () => queuePatch(() => ({ vault: vault.status(), savedPasswords: vault.savedPasswordHostIds() })));
  prompts.on('change', () => queuePatch(() => ({ prompts: prompts.list() })));
  prompts.on('ask', () => {
    if (!mainWindow?.isFocused()) showWindow();
  });
  pool.on('change', () => queuePatch(() => ({ connectedHostIds: pool.connectedHostIds() })));
  terminals.on('change', () => queuePatch(() => ({ terminals: terminals.list() })));
  sftp.on('change', () => queuePatch(() => ({ transfers: sftp.listTransfers() })));
  forwards.on('change', () => queuePatch(() => ({ forwardStatus: forwards.statuses() })));
  gateway.on('change', () => {
    queuePatch(() => ({ gateway: gateway.status() }));
    updateBadge();
  });
  gateway.on('activity', (item) => mainWindow?.webContents.send('activity:upsert', item));
  gateway.on('activity-reset', () => mainWindow?.webContents.send('activity:reset'));
  gateway.approvals.on('request', (req) => {
    updateBadge();
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    if (!mainWindow?.isFocused() && store.settings.ai.notifyOnRequest && Notification.isSupported()) {
      const zh = resolvedLanguage(store.settings.language) === 'zh-Hans';
      const what = req.command ?? req.path ?? '';
      const n = new Notification({
        title: zh ? `${req.client.name} 请求在 ${req.hostAlias} 上执行操作` : `${req.client.name} needs approval on ${req.hostAlias}`,
        body: what.length > 140 ? what.slice(0, 137) + '…' : what,
        silent: false,
      });
      n.on('click', () => {
        showWindow();
        mainWindow?.webContents.send('menu:command', 'open-approvals');
      });
      n.show();
    }
  });

  // --- MCP socket -----------------------------------------------------------------
  socketServer = new McpSocketServer(gateway, { socketPath: socketPath(), endpointPath: endpointPath(), appVersion: app.getVersion() });
  try {
    await socketServer.start();
  } catch (err) {
    gateway.error = (err as Error).message;
    console.error('[gatehouse] MCP socket failed:', err);
  }
  queuePatch(() => ({ gateway: gateway.status() }));

  // --- Auto-start tunnels -----------------------------------------------------------
  if (vault.unlocked) {
    for (const f of store.data.forwards.filter((x) => x.autoStart)) {
      forwards.start(f).catch((err) => console.warn('[gatehouse] auto-start tunnel failed', err.message));
    }
  }

  // --- Auto-lock ----------------------------------------------------------------------
  const canLock = () => touchId.available() || vault.status().passwordWrap;
  setInterval(() => {
    const mins = store.settings.security.autoLockMinutes;
    if (mins > 0 && !ui.locked && canLock() && powerMonitor.getSystemIdleTime() >= mins * 60) ctx.setUiLocked(true);
  }, 30_000);
  powerMonitor.on('lock-screen', () => {
    if (store.settings.security.autoLockMinutes > 0 && canLock()) ctx.setUiLocked(true);
  });
}

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());

app.on('before-quit', (e) => {
  if (quitting || !ctx) return;
  const s = ctx.store.settings;
  const busy = ctx.terminals.activeCount() > 0 || ctx.gateway.status().sessions.length > 0;
  if (s.confirmOnQuit && busy && mainWindow) {
    const zh = resolvedLanguage(s.language) === 'zh-Hans';
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: zh ? ['退出', '取消'] : ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: zh ? '退出 Gatehouse？' : 'Quit Gatehouse?',
      detail: zh
        ? '打开的终端会断开，AI 客户端将无法再访问你的服务器，直到你重新打开 Gatehouse。'
        : 'Open terminals will disconnect and AI clients lose access to your servers until Gatehouse is opened again.',
    });
    if (choice === 1) {
      e.preventDefault();
      return;
    }
  }
  quitting = true;
  socketServer?.stop();
  ctx.gateway.approvals.cancelAll('Gatehouse is quitting.');
  ctx.forwards.stopAll();
  ctx.terminals.closeAll();
  ctx.pool.disconnectAll();
  ctx.store.flushSync();
  tray?.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app
  .whenReady()
  .then(boot)
  .catch((err) => {
    console.error('[gatehouse] failed to start', err);
    dialog.showErrorBox('Gatehouse failed to start', String((err as Error)?.stack ?? err));
    app.quit();
  });
