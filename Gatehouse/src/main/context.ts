import { nativeTheme, type BrowserWindow } from 'electron';
import type { AppSnapshot, Toast } from '../shared/types';
import type { Store } from './store';
import type { Vault } from './vault';
import type { PromptBroker } from './prompts';
import type { ConnectionManager } from './ssh/connection';
import type { TerminalManager } from './ssh/terminal';
import type { SftpManager } from './ssh/sftp';
import type { ForwardManager } from './ssh/forwards';
import type { GatewayService } from './gateway/service';
import type { TouchIdProvider } from './gateway/approvals';

export interface AppContext {
  appVersion: string;
  store: Store;
  vault: Vault;
  prompts: PromptBroker;
  pool: ConnectionManager;
  terminals: TerminalManager;
  sftp: SftpManager;
  forwards: ForwardManager;
  gateway: GatewayService;
  touchId: TouchIdProvider;
  window(): BrowserWindow | null;
  showWindow(): void;
  ui: { locked: boolean };
  setUiLocked(locked: boolean): void;
  toast(t: Toast): void;
  onSettingsChanged(): void;
}

export function buildSnapshot(ctx: AppContext): AppSnapshot {
  const { store, vault, gateway } = ctx;
  return {
    appVersion: ctx.appVersion,
    platform: process.platform,
    hosts: store.data.hosts,
    keys: store.data.keys,
    knownHosts: store.data.knownHosts,
    forwards: store.data.forwards,
    forwardStatus: ctx.forwards.statuses(),
    snippets: store.data.snippets,
    settings: store.settings,
    gateway: gateway.status(),
    terminals: ctx.terminals.list(),
    transfers: ctx.sftp.listTransfers(),
    prompts: ctx.prompts.list(),
    savedPasswords: vault.savedPasswordHostIds(),
    connectedHostIds: ctx.pool.connectedHostIds(),
    uiLocked: ctx.ui.locked,
    darkMode: nativeTheme.shouldUseDarkColors,
    touchIdAvailable: ctx.touchId.available(),
    vault: vault.status(),
  };
}
