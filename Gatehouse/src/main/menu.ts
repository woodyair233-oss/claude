import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../shared/types';
import type { AppContext } from './context';
import { resourcePath, fileExists } from './paths';

const REPO_URL = 'https://github.com/woodyair233-oss/claude/tree/main/Gatehouse';

export function resolvedLanguage(pref: string): 'en' | 'zh-Hans' {
  if (pref === 'en' || pref === 'zh-Hans') return pref;
  const langs = app.getPreferredSystemLanguages?.() ?? [app.getLocale()];
  return langs.some((l) => l.toLowerCase().startsWith('zh')) ? 'zh-Hans' : 'en';
}

const T = {
  en: {
    about: 'About Gatehouse', settings: 'Settings…', file: 'File', newHost: 'New Host', newTerminal: 'New Terminal',
    importConfig: 'Import from SSH Config…', closeTab: 'Close Tab', lock: 'Lock Gatehouse', edit: 'Edit', find: 'Find',
    view: 'View', palette: 'Command Palette', gateway: 'AI Gateway', approvals: 'Approvals', pause: 'Pause AI Access',
    resume: 'Resume AI Access', overview: 'Gateway Overview', window: 'Window', help: 'Help', docs: 'Gatehouse on GitHub',
    open: 'Open Gatehouse', quit: 'Quit Gatehouse', active: 'AI access: active', paused: 'AI access: paused',
    pending: (n: number) => `${n} approval${n === 1 ? '' : 's'} waiting`, clients: (n: number) => `${n} AI client${n === 1 ? '' : 's'} connected`,
  },
  'zh-Hans': {
    about: '关于 Gatehouse', settings: '设置…', file: '文件', newHost: '新建主机', newTerminal: '新建终端',
    importConfig: '从 SSH 配置导入…', closeTab: '关闭标签页', lock: '锁定 Gatehouse', edit: '编辑', find: '查找',
    view: '显示', palette: '命令面板', gateway: 'AI 网关', approvals: '待批准', pause: '暂停 AI 访问',
    resume: '恢复 AI 访问', overview: '网关概览', window: '窗口', help: '帮助', docs: '在 GitHub 上查看 Gatehouse',
    open: '打开 Gatehouse', quit: '退出 Gatehouse', active: 'AI 访问：已开启', paused: 'AI 访问：已暂停',
    pending: (n: number) => `${n} 个请求待批准`, clients: (n: number) => `${n} 个 AI 客户端已连接`,
  },
};

export function buildAppMenu(ctx: AppContext) {
  const t = T[resolvedLanguage(ctx.store.settings.language)];
  const send = (cmd: MenuCommand) => () => {
    ctx.showWindow();
    ctx.window()?.webContents.send('menu:command', cmd);
  };
  const enabled = ctx.store.settings.ai.enabled;
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: t.about },
              { type: 'separator' },
              { label: t.settings, accelerator: 'Cmd+,', click: send('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: t.quit },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t.file,
      submenu: [
        { label: t.newHost, accelerator: 'CmdOrCtrl+N', click: send('new-host') },
        { label: t.newTerminal, accelerator: 'CmdOrCtrl+T', click: send('new-terminal') },
        { label: t.importConfig, click: send('import-ssh-config') },
        { type: 'separator' },
        { label: t.closeTab, accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
        { type: 'separator' },
        { label: t.lock, accelerator: 'CmdOrCtrl+L', click: send('lock') },
        ...(!mac ? ([{ type: 'separator' }, { label: t.settings, accelerator: 'Ctrl+,', click: send('settings') }, { role: 'quit' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      label: t.edit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: t.find, accelerator: 'CmdOrCtrl+F', click: send('find') },
      ],
    },
    {
      label: t.view,
      submenu: [
        { label: t.palette, accelerator: 'CmdOrCtrl+K', click: send('command-palette') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      label: t.gateway,
      submenu: [
        { label: t.overview, click: send('open-gateway') },
        { label: t.approvals, accelerator: 'CmdOrCtrl+Shift+A', click: send('open-approvals') },
        { type: 'separator' },
        {
          label: enabled ? t.pause : t.resume,
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => ctx.gateway.setEnabled(!ctx.store.settings.ai.enabled),
        },
      ],
    },
    { label: t.window, role: 'windowMenu' },
    { label: t.help, role: 'help', submenu: [{ label: t.docs, click: () => void shell.openExternal(REPO_URL) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export class TrayController {
  private tray?: Tray;

  constructor(private readonly ctx: AppContext) {}

  sync() {
    const s = this.ctx.store.settings;
    if (!s.showInMenuBar) {
      this.tray?.destroy();
      this.tray = undefined;
      return;
    }
    if (!this.tray) {
      const file = resourcePath('tray', 'trayTemplate.png');
      const icon = fileExists(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
      icon.setTemplateImage(true);
      this.tray = new Tray(icon);
      this.tray.setToolTip('Gatehouse');
      if (icon.isEmpty()) this.tray.setTitle('GH');
    }
    this.update();
  }

  update() {
    if (!this.tray) return;
    const { gateway, store } = this.ctx;
    const t = T[resolvedLanguage(store.settings.language)];
    const status = gateway.status();
    const pending = status.pending.length;
    const enabled = store.settings.ai.enabled;
    this.tray.setTitle(pending ? ` ${pending}` : '', { fontType: 'monospacedDigit' });
    const send = (cmd: MenuCommand) => () => {
      this.ctx.showWindow();
      this.ctx.window()?.webContents.send('menu:command', cmd);
    };
    const menu = Menu.buildFromTemplate([
      { label: enabled ? t.active : t.paused, enabled: false },
      ...(pending ? [{ label: t.pending(pending), click: send('open-approvals') }] : []),
      { label: t.clients(status.sessions.length), enabled: false },
      { type: 'separator' },
      { label: enabled ? t.pause : t.resume, click: () => gateway.setEnabled(!store.settings.ai.enabled) },
      { type: 'separator' },
      { label: t.open, click: () => this.ctx.showWindow() },
      { label: t.quit, role: 'quit' },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy() {
    this.tray?.destroy();
  }
}
