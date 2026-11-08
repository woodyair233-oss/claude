import { create } from 'zustand';
import type { ActivityItem, AppSnapshot, MenuCommand, SnapshotPatch, Toast } from '@shared/types';

export type ViewId =
  | 'hosts'
  | 'terminals'
  | 'files'
  | 'tunnels'
  | 'keys'
  | 'snippets'
  | 'gateway'
  | 'approvals'
  | 'activity'
  | 'policies'
  | 'audit'
  | 'settings';

/** A toast may carry one action button (renderer-only; main-process toasts have none). */
export interface ToastInput extends Toast {
  action?: { label: string; run: () => void };
}

export interface ToastItem extends ToastInput {
  id: number;
}

interface UiState {
  snap: AppSnapshot | null;
  activity: ActivityItem[];
  view: ViewId;
  paletteOpen: boolean;
  hostEditor: { open: boolean; hostId?: string; tab?: string; duplicateOf?: string };
  settingsTab: string;
  activeTerminal?: string;
  filesHostId?: string;
  toasts: ToastItem[];
  menuCommand?: { cmd: MenuCommand; at: number };
  hostPicker?: { title: string; resolve: (hostId: string | null) => void };
  /** The connection-log dialog: whose log, which attempt to show first, and where it was opened from. */
  connLog?: { hostId: string; attemptId?: string; at: number; from?: { hostId: string; attemptId?: string } };

  setSnapshot(s: AppSnapshot): void;
  applyPatch(p: SnapshotPatch): void;
  setActivity(a: ActivityItem[]): void;
  upsertActivity(a: ActivityItem): void;
  go(view: ViewId): void;
  setPalette(open: boolean): void;
  openHostEditor(hostId?: string, tab?: string): void;
  closeHostEditor(): void;
  setSettingsTab(tab: string): void;
  setActiveTerminal(id?: string): void;
  setFilesHost(id?: string): void;
  toast(t: ToastInput): void;
  dismissToast(id: number): void;
  openConnLog(hostId: string, attemptId?: string, from?: { hostId: string; attemptId?: string }): void;
  closeConnLog(): void;
  setMenuCommand(cmd: MenuCommand): void;
  pickHost(title: string): Promise<string | null>;
  closeHostPicker(result: string | null): void;
}

let toastId = 0;

export const useApp = create<UiState>((set, get) => ({
  snap: null,
  activity: [],
  view: 'hosts',
  paletteOpen: false,
  hostEditor: { open: false },
  settingsTab: 'general',
  toasts: [],

  setSnapshot: (snap) => set({ snap }),
  applyPatch: (p) => {
    const cur = get().snap;
    if (cur) set({ snap: { ...cur, ...p } });
  },
  setActivity: (activity) => set({ activity }),
  upsertActivity: (item) => {
    const list = get().activity;
    const i = list.findIndex((a) => a.id === item.id);
    if (i >= 0) {
      const next = list.slice();
      next[i] = item;
      set({ activity: next });
    } else {
      set({ activity: [item, ...list].slice(0, 400) });
    }
  },
  go: (view) => set({ view, paletteOpen: false }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  openHostEditor: (hostId, tab) => set({ hostEditor: { open: true, hostId, tab } }),
  closeHostEditor: () => set({ hostEditor: { open: false } }),
  setSettingsTab: (settingsTab) => set({ settingsTab, view: 'settings' }),
  setActiveTerminal: (activeTerminal) => set({ activeTerminal }),
  setFilesHost: (filesHostId) => set({ filesHostId }),
  toast: (t) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { ...t, id }].slice(-4) });
    setTimeout(() => get().dismissToast(id), t.action ? 12_000 : t.kind === 'error' ? 7000 : 4200);
  },
  openConnLog: (hostId, attemptId, from) => set({ connLog: { hostId, attemptId, at: Date.now(), from } }),
  closeConnLog: () => set({ connLog: undefined }),
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setMenuCommand: (cmd) => set({ menuCommand: { cmd, at: Date.now() } }),
  pickHost: (title) =>
    new Promise((resolve) => {
      set({ hostPicker: { title, resolve } });
    }),
  closeHostPicker: (result) => {
    const p = get().hostPicker;
    set({ hostPicker: undefined });
    p?.resolve(result);
  },
}));

export const api = () => window.gatehouse;

/** Runs an async action and reports failures as a toast. */
export async function attempt<T>(fn: () => Promise<T>, errorTitle: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    useApp.getState().toast({ kind: 'error', title: errorTitle, message: (err as Error).message });
    return undefined;
  }
}
