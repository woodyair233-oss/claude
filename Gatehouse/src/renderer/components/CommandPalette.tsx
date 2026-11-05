import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowRight, ClipboardCheck, FileClock, FolderOpen, Import, KeyRound, LayoutDashboard, Lock, Moon, Network, Pause, Play, Plus, Search, Server, Settings, SlidersHorizontal, SquareTerminal, Sun, Zap } from 'lucide-react';
import { api, useApp, type ViewId } from '../lib/store';
import { t } from '../lib/i18n';
import { openFiles, openTerminal } from '../lib/actions';
import { HostDot } from './domain';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
  keywords?: string;
}

function score(item: Item, q: string): number {
  if (!q) return 1;
  const hay = `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  const query = q.toLowerCase();
  if (hay.startsWith(query)) return 3;
  if (hay.includes(query)) return 2;
  let i = 0;
  for (const ch of hay) if (ch === query[i]) i++;
  return i === query.length ? 1 : 0;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPalette);
  const snap = useApp((s) => s.snap);
  const go = useApp((s) => s.go);
  const openEditor = useApp((s) => s.openHostEditor);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!snap) return [];
    const nav = (view: ViewId, label: string, icon: React.ReactNode, keywords?: string): Item => ({ id: `nav-${view}`, group: t('Go to'), label, icon, run: () => go(view), keywords });
    const hostItems = snap.hosts.flatMap((h) => [
      { id: `ssh-${h.id}`, group: t('Hosts'), label: h.name || h.alias, hint: t('Open terminal'), icon: <HostDot color={h.color} />, run: () => void openTerminal(h.id), keywords: `${h.alias} ${h.hostname} ${h.tags.join(' ')} ssh connect` },
      { id: `sftp-${h.id}`, group: t('Hosts'), label: `${h.name || h.alias}`, hint: t('Browse files'), icon: <FolderOpen size={14} />, run: () => openFiles(h.id), keywords: `${h.alias} sftp files` },
      { id: `edit-${h.id}`, group: t('Hosts'), label: `${h.name || h.alias}`, hint: t('Edit host'), icon: <Server size={14} />, run: () => openEditor(h.id), keywords: `${h.alias} edit settings` },
    ]);
    const enabled = snap.settings.ai.enabled;
    const dark = snap.darkMode;
    return [
      { id: 'new-host', group: t('Actions'), label: t('New Host'), icon: <Plus size={14} />, run: () => openEditor() },
      { id: 'toggle-ai', group: t('Actions'), label: enabled ? t('Pause AI access') : t('Resume AI access'), icon: enabled ? <Pause size={14} /> : <Play size={14} />, run: () => void api().gateway.setEnabled(!enabled), keywords: 'kill switch stop' },
      { id: 'theme', group: t('Actions'), label: dark ? t('Switch to light appearance') : t('Switch to dark appearance'), icon: dark ? <Sun size={14} /> : <Moon size={14} />, run: () => void api().settings.update({ theme: dark ? 'light' : 'dark' }) },
      { id: 'lock', group: t('Actions'), label: t('Lock Gatehouse'), icon: <Lock size={14} />, run: () => void api().app.lock().catch(() => undefined) },
      { id: 'import', group: t('Actions'), label: t('Import from SSH config'), icon: <Import size={14} />, run: () => useApp.getState().setMenuCommand('import-ssh-config') },
      ...hostItems,
      nav('hosts', t('Hosts'), <Server size={14} />),
      nav('terminals', t('Terminals'), <SquareTerminal size={14} />),
      nav('files', t('Files'), <FolderOpen size={14} />, 'sftp'),
      nav('tunnels', t('Tunnels'), <Network size={14} />, 'port forward socks'),
      nav('keys', t('Keys'), <KeyRound size={14} />),
      nav('snippets', t('Snippets'), <Zap size={14} />),
      nav('gateway', t('AI Gateway'), <LayoutDashboard size={14} />, 'mcp claude setup'),
      nav('approvals', t('Approvals'), <ClipboardCheck size={14} />),
      nav('activity', t('Activity'), <Activity size={14} />),
      nav('policies', t('Policies'), <SlidersHorizontal size={14} />, 'redaction rules'),
      nav('audit', t('Audit Log'), <FileClock size={14} />),
      nav('settings', t('Settings'), <Settings size={14} />, 'preferences'),
    ];
  }, [snap, go, openEditor]);

  const results = useMemo(() => {
    const scored = items.map((it) => ({ it, s: score(it, q.trim()) })).filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.it).slice(0, 40);
  }, [items, q]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.pal-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const run = (it: Item | undefined) => {
    if (!it) return;
    setOpen(false);
    it.run();
  };
  let lastGroup = '';
  return createPortal(
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label={t('Command palette')}>
        <div className="pal-input">
          <Search size={16} className="faint" />
          <input
            autoFocus
            value={q}
            placeholder={t('Search hosts, actions and pages…')}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(results[sel]);
              } else if (e.key === 'Escape') setOpen(false);
            }}
          />
        </div>
        <div className="pal-list" ref={listRef}>
          {results.length === 0 && <div className="faint" style={{ padding: 20, textAlign: 'center' }}>{t('No results')}</div>}
          {results.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="pal-group">{header}</div>}
                <button className={`pal-item ${i === sel ? 'sel' : ''}`} onMouseMove={() => setSel(i)} onClick={() => run(it)}>
                  <span className="pal-icon">{it.icon}</span>
                  <span className="ellipsis">{it.label}</span>
                  {it.hint && <span className="faint ellipsis" style={{ fontSize: 12 }}>{it.hint}</span>}
                  {i === sel && <ArrowRight size={13} className="faint" style={{ marginLeft: 'auto' }} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
