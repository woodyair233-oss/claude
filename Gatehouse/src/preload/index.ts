// Sandboxed preload: exposes a narrow, typed API. No Node primitives leak to the page.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { GatehouseApi } from '../shared/api';

function unwrap(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
}

const invoke =
  <T>(channel: string) =>
  (...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args).catch(unwrap) as Promise<T>;

const send =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.send(channel, ...args);

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void) {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: GatehouseApi = {
  platform: process.platform,
  getSnapshot: invoke('app:snapshot'),
  getActivity: invoke('gateway:activity'),
  on: {
    patch: (cb) => subscribe('state:patch', cb),
    activity: (cb) => subscribe('activity:upsert', cb),
    activityReset: (cb) => subscribe('activity:reset', cb),
    terminalData: (cb) => subscribe('term:data', cb),
    menu: (cb) => subscribe('menu:command', cb),
    toast: (cb) => subscribe('app:toast', cb),
  },
  hosts: {
    save: invoke('hosts:save'),
    remove: invoke('hosts:remove'),
    duplicate: invoke('hosts:duplicate'),
    test: invoke('hosts:test'),
    disconnect: invoke('hosts:disconnect'),
    scanSshConfig: invoke('hosts:scanSshConfig'),
    importSshConfig: invoke('hosts:importSshConfig'),
    copySshCommand: invoke('hosts:copySshCommand'),
  },
  keys: {
    generate: invoke('keys:generate'),
    importText: invoke('keys:importText'),
    pickFile: invoke('keys:pickFile'),
    rename: invoke('keys:rename'),
    remove: invoke('keys:remove'),
    copyPublic: invoke('keys:copyPublic'),
    exportPublic: invoke('keys:exportPublic'),
    deploy: invoke('keys:deploy'),
  },
  knownHosts: {
    remove: invoke('knownHosts:remove'),
  },
  terminal: {
    open: invoke('term:open'),
    write: send('term:write'),
    resize: send('term:resize'),
    ack: send('term:ack'),
    close: send('term:close'),
    reconnect: send('term:reconnect'),
    rename: send('term:rename'),
  },
  sftp: {
    home: invoke('sftp:home'),
    list: invoke('sftp:list'),
    mkdir: invoke('sftp:mkdir'),
    rename: invoke('sftp:rename'),
    remove: invoke('sftp:remove'),
    chmod: invoke('sftp:chmod'),
    readText: invoke('sftp:readText'),
    writeText: invoke('sftp:writeText'),
    download: invoke('sftp:download'),
    upload: invoke('sftp:upload'),
    cancelTransfer: invoke('sftp:cancelTransfer'),
    clearTransfers: invoke('sftp:clearTransfers'),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  forwards: {
    save: invoke('forwards:save'),
    remove: invoke('forwards:remove'),
    start: invoke('forwards:start'),
    stop: invoke('forwards:stop'),
  },
  snippets: {
    save: invoke('snippets:save'),
    remove: invoke('snippets:remove'),
  },
  gateway: {
    setEnabled: invoke('gateway:setEnabled'),
    decide: invoke('gateway:decide'),
    revokeGrant: invoke('gateway:revokeGrant'),
    disconnectClients: invoke('gateway:disconnectClients'),
    clearActivity: invoke('gateway:clearActivity'),
    queryAudit: invoke('gateway:queryAudit'),
    verifyAudit: invoke('gateway:verifyAudit'),
    exportAudit: invoke('gateway:exportAudit'),
    setupInfo: invoke('gateway:setupInfo'),
    installClaudeCode: invoke('gateway:installClaudeCode'),
    installClaudeDesktop: invoke('gateway:installClaudeDesktop'),
    selfTest: invoke('gateway:selfTest'),
    previewRedaction: invoke('gateway:previewRedaction'),
    previewCommand: invoke('gateway:previewCommand'),
    tokenMap: invoke('gateway:tokenMap'),
  },
  settings: {
    update: invoke('settings:update'),
  },
  prompts: {
    respond: invoke('prompts:respond'),
  },
  vault: {
    create: invoke('vault:create'),
    unlock: invoke('vault:unlock'),
    setPassword: invoke('vault:setPassword'),
    setKeychain: invoke('vault:setKeychain'),
  },
  app: {
    lock: invoke('app:lock'),
    unlock: invoke('app:unlock'),
    openExternal: invoke('app:openExternal'),
    showDataFolder: invoke('app:showDataFolder'),
    clipboardWrite: invoke('app:clipboardWrite'),
    clipboardRead: invoke('app:clipboardRead'),
    contextMenu: invoke('app:contextMenu'),
    exportBackup: invoke('app:exportBackup'),
    importBackup: invoke('app:importBackup'),
    quit: invoke('app:quit'),
  },
};

contextBridge.exposeInMainWorld('gatehouse', api);
