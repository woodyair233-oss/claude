import type { Host, Snippet } from '@shared/types';
import { draftOf } from '@shared/defaults';
import { api, attempt, useApp } from './store';
import { t } from './i18n';
import { confirmDialog } from '../components/overlays';
import { ensureTerminal } from './terminal-registry';
import { causeTitle } from './conn';

export async function openTerminal(hostId: string): Promise<string | undefined> {
  const { snap, go, setActiveTerminal } = useApp.getState();
  const id = await attempt(() => api().terminal.open(hostId, 120, 32), t('Could not open terminal'));
  if (!id) return undefined;
  if (snap) ensureTerminal(id, snap.settings.terminal);
  setActiveTerminal(id);
  go('terminals');
  return id;
}

export function openFiles(hostId: string) {
  const s = useApp.getState();
  s.setFilesHost(hostId);
  s.go('files');
}

export async function testHost(host: Host) {
  const { toast } = useApp.getState();
  toast({ kind: 'info', title: t('Testing {name}…', { name: host.name || host.alias }) });
  const r = await attempt(() => api().hosts.test(host.id), t('Connection failed'));
  if (!r) return;
  if (r.ok) {
    toast({ kind: 'success', title: t('Connected to {name}', { name: host.name || host.alias }), message: [r.osInfo, r.latencyMs ? `${r.latencyMs} ms` : ''].filter(Boolean).join(' · ') });
    return;
  }
  toast({
    kind: 'error',
    title: t('Could not connect to {name}', { name: host.name || host.alias }),
    message: r.cause ? causeTitle(r.cause, r.causeParams) : r.message,
    action: r.attemptId ? { label: t('View details'), run: () => useApp.getState().openConnLog(host.id, r.attemptId) } : undefined,
  });
}

export async function deleteHost(host: Host) {
  const ok = await confirmDialog({
    title: t('Delete "{name}"?', { name: host.name || host.alias }),
    message: t('Its saved password, tunnels and open sessions are removed too. Keys are kept.'),
    confirmLabel: t('Delete'),
    danger: true,
  });
  if (!ok) return;
  await attempt(() => api().hosts.remove(host.id), t('Could not delete host'));
}

export async function duplicateHost(host: Host) {
  const copy = await attempt(() => api().hosts.duplicate(host.id), t('Could not duplicate host'));
  if (copy) useApp.getState().openHostEditor(copy.id);
}

export async function hostContextMenu(host: Host) {
  const connected = useApp.getState().snap?.connectedHostIds.includes(host.id);
  const choice = await api().app.contextMenu([
    { id: 'terminal', label: t('Open Terminal') },
    { id: 'files', label: t('Browse Files') },
    { type: 'separator' },
    { id: 'edit', label: t('Edit…') },
    { id: 'duplicate', label: t('Duplicate') },
    { id: 'copy', label: t('Copy SSH Command') },
    { id: 'test', label: t('Test Connection') },
    { id: 'connlog', label: t('Connection Log…') },
    ...(connected ? [{ id: 'disconnect', label: t('Disconnect') }] : []),
    { type: 'separator' },
    { id: 'favorite', label: host.favorite ? t('Remove from Favorites') : t('Add to Favorites') },
    { type: 'separator' },
    { id: 'delete', label: t('Delete…') },
  ]);
  const s = useApp.getState();
  switch (choice) {
    case 'terminal':
      return openTerminal(host.id);
    case 'files':
      return openFiles(host.id);
    case 'edit':
      return s.openHostEditor(host.id);
    case 'duplicate':
      return duplicateHost(host);
    case 'copy':
      await api().hosts.copySshCommand(host.id);
      return s.toast({ kind: 'success', title: t('SSH command copied') });
    case 'test':
      return testHost(host);
    case 'connlog':
      return s.openConnLog(host.id);
    case 'disconnect':
      return api().hosts.disconnect(host.id);
    case 'favorite':
      return toggleFavorite(host);
    case 'delete':
      return deleteHost(host);
  }
}

export async function toggleFavorite(host: Host) {
  await attempt(() => api().hosts.save({ ...draftOf(host), favorite: !host.favorite }), t('Could not update host'));
}

export async function setHostMode(host: Host, mode: Host['ai']['mode']) {
  const draft = draftOf(host);
  await attempt(() => api().hosts.save({ ...draft, ai: { ...draft.ai, mode } }), t('Could not update host'));
}

export async function runSnippetInTerminal(snippet: Snippet, hostId?: string) {
  const s = useApp.getState();
  const target = hostId ?? (await s.pickHost(t('Run "{name}" on…', { name: snippet.name })));
  if (!target) return;
  const existing = s.snap?.terminals.find((x) => x.hostId === target && x.state === 'connected');
  const id = existing?.id ?? (await openTerminal(target));
  if (!id) return;
  s.setActiveTerminal(id);
  s.go('terminals');
  // Raw input + Enter (not paste: bracketed-paste shells would not execute a pasted newline).
  const send = () => api().terminal.write(id, snippet.command.replace(/\n+$/, '').replace(/\n/g, '\r') + '\r');
  if (existing) send();
  else {
    const started = Date.now();
    const wait = setInterval(() => {
      const state = useApp.getState().snap?.terminals.find((x) => x.id === id)?.state;
      if (state === 'connected') {
        clearInterval(wait);
        setTimeout(send, 400);
      } else if (state === 'error' || Date.now() - started > 30_000) clearInterval(wait);
    }, 150);
  }
}
