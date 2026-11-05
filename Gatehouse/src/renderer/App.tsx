import { useEffect, useState } from 'react';
import type { AppSnapshot } from '@shared/types';
import { api, useApp } from './lib/store';
import { setLang, t } from './lib/i18n';
import { applyAccent } from './lib/themes';
import { applyTerminalSettings, startTerminalDataPump } from './lib/terminal-registry';
import { Sidebar } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import { PromptHost } from './components/Prompts';
import { ApprovalModal } from './components/Approval';
import { LockScreen, VaultGate, Welcome } from './components/Gates';
import { DialogHost, Toasts } from './components/overlays';
import { HostPicker, PasteGuard } from './components/Pickers';
import { HostsView } from './views/HostsView';
import { HostEditor } from './views/HostEditor';
import { TerminalsView } from './views/TerminalsView';
import { FilesView } from './views/FilesView';
import { TunnelsView } from './views/TunnelsView';
import { KeysView } from './views/KeysView';
import { SnippetsView } from './views/SnippetsView';
import { GatewayView } from './views/GatewayView';
import { ApprovalsView } from './views/ApprovalsView';
import { ActivityView } from './views/ActivityView';
import { PoliciesView } from './views/PoliciesView';
import { AuditView } from './views/AuditView';
import { SettingsView } from './views/SettingsView';
import { ImportDialog } from './views/ImportDialog';
import { Spinner } from './components/ui';

function useBootstrap() {
  const setSnapshot = useApp((s) => s.setSnapshot);
  const applyPatch = useApp((s) => s.applyPatch);
  const setActivity = useApp((s) => s.setActivity);
  const upsertActivity = useApp((s) => s.upsertActivity);
  const toast = useApp((s) => s.toast);
  const setMenuCommand = useApp((s) => s.setMenuCommand);
  useEffect(() => {
    startTerminalDataPump();
    let disposed = false;
    void api()
      .getSnapshot()
      .then((s: AppSnapshot) => !disposed && setSnapshot(s));
    void api()
      .getActivity()
      .then((a) => !disposed && setActivity(a));
    const offs = [
      api().on.patch(applyPatch),
      api().on.activity(upsertActivity),
      api().on.activityReset(() => void api().getActivity().then(setActivity)),
      api().on.toast(toast),
      api().on.menu(setMenuCommand),
    ];
    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [setSnapshot, applyPatch, setActivity, upsertActivity, toast, setMenuCommand]);
}

function useAppearance() {
  const settings = useApp((s) => s.snap?.settings);
  const dark = useApp((s) => s.snap?.darkMode);
  useEffect(() => {
    if (dark === undefined) return;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  useEffect(() => {
    if (!settings) return;
    applyAccent(settings.accent);
    applyTerminalSettings(settings.terminal);
  }, [settings, dark]);
}

function useMenuCommands() {
  const menu = useApp((s) => s.menuCommand);
  const go = useApp((s) => s.go);
  const openEditor = useApp((s) => s.openHostEditor);
  const setPalette = useApp((s) => s.setPalette);
  const view = useApp((s) => s.view);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (!menu) return;
    switch (menu.cmd) {
      case 'new-host':
        openEditor();
        break;
      case 'command-palette':
        setPalette(!useApp.getState().paletteOpen);
        break;
      case 'settings':
        go('settings');
        break;
      case 'open-approvals':
        go('approvals');
        break;
      case 'open-gateway':
        go('gateway');
        break;
      case 'import-ssh-config':
        setImporting(true);
        break;
      case 'lock':
        void api().app.lock().catch((err) => useApp.getState().toast({ kind: 'info', title: t('Cannot lock'), message: (err as Error).message }));
        break;
      case 'new-terminal':
        if (view !== 'terminals') go('terminals');
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);
  return { importing, setImporting };
}

function Main() {
  const view = useApp((s) => s.view);
  switch (view) {
    case 'hosts':
      return <HostsView />;
    case 'terminals':
      return <TerminalsView />;
    case 'files':
      return <FilesView />;
    case 'tunnels':
      return <TunnelsView />;
    case 'keys':
      return <KeysView />;
    case 'snippets':
      return <SnippetsView />;
    case 'gateway':
      return <GatewayView />;
    case 'approvals':
      return <ApprovalsView />;
    case 'activity':
      return <ActivityView />;
    case 'policies':
      return <PoliciesView />;
    case 'audit':
      return <AuditView />;
    case 'settings':
      return <SettingsView />;
  }
}

export function App() {
  useBootstrap();
  useAppearance();
  const snap = useApp((s) => s.snap);
  const editorOpen = useApp((s) => s.hostEditor.open);
  const editorKey = useApp((s) => `${s.hostEditor.hostId ?? 'new'}`);
  const { importing, setImporting } = useMenuCommands();

  useEffect(() => {
    document.documentElement.classList.add(`platform-${window.gatehouse.platform}`);
  }, []);

  // When the app locks, drop focus so no control underneath the lock screen
  // keeps it (the subtree is also made inert below).
  const locked = !!snap?.uiLocked;
  useEffect(() => {
    if (locked) (document.activeElement as HTMLElement | null)?.blur?.();
  }, [locked]);

  if (!snap) {
    return (
      <div className="boot">
        <Spinner large />
      </div>
    );
  }
  const lang = setLang(snap.settings.language);
  if (snap.vault.state !== 'unlocked') return <VaultGate key={lang} />;

  return (
    <div className="app" key={lang}>
      <div className="app-inner" style={{ display: 'contents' }} inert={locked ? true : undefined}>
        <Sidebar />
        <main className="main">
          <Main />
        </main>
        {editorOpen && <HostEditor key={editorKey} />}
        {importing && <ImportDialog onClose={() => setImporting(false)} />}
        <CommandPalette />
        <ApprovalModal />
        <PromptHost />
        <HostPicker />
        <PasteGuard />
        <DialogHost />
        <Welcome />
        <Toasts />
      </div>
      {locked && <LockScreen />}
    </div>
  );
}
