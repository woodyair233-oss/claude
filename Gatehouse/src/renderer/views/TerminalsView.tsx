import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, RotateCw, Search, SquareTerminal, Stethoscope, X, Zap } from 'lucide-react';
import type { TerminalSessionInfo } from '@shared/types';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { attachTerminal, clearSearch, clearTerminal, disposeTerminal, ensureTerminal, fitTerminal, focusTerminal, getSelection, searchTerminal } from '../lib/terminal-registry';
import { openTerminal } from '../lib/actions';
import { terminalTheme } from '../lib/themes';
import { causeTitle } from '../lib/conn';
import { Toolbar } from '../components/Toolbar';
import { Button, EmptyState, IconButton, Spinner } from '../components/ui';
import { HostDot } from '../components/domain';
import { promptDialog } from '../components/overlays';

function bannerText(session: TerminalSessionInfo): string {
  if (session.state === 'closed') return t('Session ended');
  if (session.cause) return causeTitle(session.cause, session.causeParams);
  // Plain closes carry this fixed English text from the main process.
  if (session.error === 'Connection closed') return t('Connection closed');
  return session.error || t('Connection failed');
}

function TerminalPane({ session, active }: { session: TerminalSessionInfo; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const settings = useApp((s) => s.snap!.settings.terminal);
  useLayoutEffect(() => {
    ensureTerminal(session.id, settings);
    if (ref.current) attachTerminal(session.id, ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fitTerminal(session.id);
      focusTerminal(session.id);
    });
    return () => cancelAnimationFrame(id);
  }, [active, session.id, session.state]);
  const bg = terminalTheme(settings.theme).theme.background;
  return (
    <div className={`term-pane ${active ? 'active' : ''}`} style={{ background: bg }}>
      <div ref={ref} className="term-mount" />
      {session.state === 'connecting' && (
        <div className="term-overlay">
          <Spinner large />
          <div>{t('Connecting…')}</div>
        </div>
      )}
      {(session.state === 'error' || session.state === 'closed') && (
        <div className="term-banner">
          <span className={`status-dot ${session.state === 'error' ? 'err' : ''}`} />
          <span className="grow ellipsis" title={bannerText(session)}>
            {bannerText(session)}
          </span>
          {session.attemptId && (
            <Button size="sm" variant="ghost" icon={<Stethoscope size={13} />} onClick={() => useApp.getState().openConnLog(session.hostId, session.attemptId)}>
              {t('View details')}
            </Button>
          )}
          <Button size="sm" variant="primary" icon={<RotateCw size={13} />} onClick={() => api().terminal.reconnect(session.id)}>
            {t('Reconnect')}
          </Button>
        </div>
      )}
    </div>
  );
}

function SnippetDrawer({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  const snippets = useApp((s) => s.snap!.snippets);
  return (
    <aside className="snippet-drawer">
      <div className="row" style={{ padding: '10px 12px', borderBottom: '1px solid var(--separator)' }}>
        <Zap size={14} color="var(--accent)" />
        <strong className="grow">{t('Snippets')}</strong>
        <IconButton label={t('Close')} small onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div style={{ overflow: 'auto', flex: 1, padding: 8 }}>
        {snippets.length === 0 && <div className="faint" style={{ padding: 12 }}>{t('No snippets yet.')}</div>}
        {snippets.map((sn) => (
          <button
            key={sn.id}
            className="snippet-item"
            disabled={!sessionId}
            onClick={() => {
              if (!sessionId) return;
              api().terminal.write(sessionId, sn.command.replace(/\n+$/, '').replace(/\n/g, '\r') + '\r');
              focusTerminal(sessionId);
            }}
            title={sn.command}
          >
            <div className="ellipsis" style={{ fontWeight: 550 }}>{sn.name}</div>
            <div className="mono faint ellipsis" style={{ fontSize: 11 }}>{sn.command}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function TerminalsView() {
  const sessions = useApp((s) => s.snap!.terminals);
  const hosts = useApp((s) => s.snap!.hosts);
  const active = useApp((s) => s.activeTerminal);
  const setActive = useApp((s) => s.setActiveTerminal);
  const pickHost = useApp((s) => s.pickHost);
  const menu = useApp((s) => s.menuCommand);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const known = useRef(new Set<string>());

  const current = sessions.find((s) => s.id === active) ?? sessions[sessions.length - 1];

  // Dispose xterm instances whose sessions disappeared.
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id));
    for (const id of known.current) if (!ids.has(id)) disposeTerminal(id);
    known.current = ids;
    if (current && current.id !== active) setActive(current.id);
  }, [sessions, current, active, setActive]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !current) return;
    const ro = new ResizeObserver(() => fitTerminal(current.id));
    ro.observe(el);
    return () => ro.disconnect();
  }, [current]);

  const newTab = async () => {
    const hostId = await pickHost(t('Open a terminal on…'));
    if (hostId) await openTerminal(hostId);
  };
  const closeTab = (id: string) => {
    api().terminal.close(id);
    disposeTerminal(id);
  };

  useEffect(() => {
    if (!menu || Date.now() - menu.at > 1000) return;
    if (menu.cmd === 'new-terminal') void newTab();
    if (menu.cmd === 'close-tab' && current) closeTab(current.id);
    if (menu.cmd === 'find' && current) setSearchOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      if (/^[1-9]$/.test(e.key)) {
        const s = sessions[Number(e.key) - 1];
        if (s) {
          e.preventDefault();
          setActive(s.id);
        }
      } else if ((e.key === ']' || e.key === '[') && e.shiftKey && current) {
        const i = sessions.findIndex((s) => s.id === current.id);
        const next = sessions[(i + (e.key === ']' ? 1 : -1) + sessions.length) % sessions.length];
        if (next) setActive(next.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions, current, setActive]);

  const tabMenu = async (s: TerminalSessionInfo) => {
    const choice = await api().app.contextMenu([
      { id: 'copy', label: t('Copy'), enabled: !!getSelection(s.id) },
      { id: 'clear', label: t('Clear Screen') },
      { id: 'rename', label: t('Rename Tab…') },
      { id: 'reconnect', label: t('Reconnect'), enabled: s.state !== 'connected' && s.state !== 'connecting' },
      { id: 'duplicate', label: t('New Tab on Same Host') },
      { type: 'separator' },
      { id: 'close', label: t('Close Tab') },
      { id: 'close-others', label: t('Close Other Tabs'), enabled: sessions.length > 1 },
    ]);
    if (choice === 'copy') void api().app.clipboardWrite(getSelection(s.id));
    if (choice === 'clear') clearTerminal(s.id);
    if (choice === 'reconnect') api().terminal.reconnect(s.id);
    if (choice === 'duplicate') void openTerminal(s.hostId);
    if (choice === 'close') closeTab(s.id);
    if (choice === 'close-others') sessions.filter((x) => x.id !== s.id).forEach((x) => closeTab(x.id));
    if (choice === 'rename') {
      const name = await promptDialog({ title: t('Rename tab'), initial: s.title });
      if (name) api().terminal.rename(s.id, name);
    }
  };

  if (sessions.length === 0) {
    const recent = [...hosts].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0)).slice(0, 6);
    return (
      <>
        <Toolbar title={t('Terminals')} />
        <div className="content">
          <EmptyState
            icon={<SquareTerminal size={40} strokeWidth={1.5} />}
            title={t('No open terminals')}
            actions={
              <Button size="lg" variant="primary" icon={<Plus size={15} />} onClick={() => void newTab()} disabled={!hosts.length}>
                {t('New Terminal')}
              </Button>
            }
          >
            {hosts.length ? t('Open a session on one of your hosts.') : t('Add a host first.')}
          </EmptyState>
          {recent.length > 0 && (
            <div className="quick-connect">
              {recent.map((h) => (
                <button key={h.id} className="qc-item" onClick={() => void openTerminal(h.id)}>
                  <HostDot color={h.color} />
                  <span className="ellipsis">{h.name || h.alias}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <header className="toolbar drag term-toolbar">
        <div className="term-tabs no-drag">
          {sessions.map((s, i) => {
            const host = hosts.find((h) => h.id === s.hostId);
            return (
              <div
                key={s.id}
                className={`term-tab ${s.id === current?.id ? 'on' : ''}`}
                onMouseDown={(e) => e.button === 0 && setActive(s.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void tabMenu(s);
                }}
                title={`${s.title} (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}${i + 1})`}
              >
                {s.state === 'connecting' ? <Spinner /> : <HostDot color={host?.color ?? 'gray'} size={7} />}
                <span className={`ellipsis ${s.state === 'closed' || s.state === 'error' ? 'faint' : ''}`}>{s.title}</span>
                <button
                  className="tab-close"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(s.id);
                  }}
                  aria-label={t('Close Tab')}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
          <IconButton label={t('New Terminal')} small onClick={() => void newTab()}>
            <Plus size={14} />
          </IconButton>
        </div>
        <div className="tb-actions">
          <IconButton label={t('Find')} active={searchOpen} onClick={() => setSearchOpen((v) => !v)}>
            <Search size={15} />
          </IconButton>
          <IconButton label={t('Snippets')} active={drawer} onClick={() => setDrawer((v) => !v)}>
            <Zap size={15} />
          </IconButton>
        </div>
      </header>
      <div className="term-stage-wrap">
        <div className="term-stage" ref={stageRef}>
          {sessions.map((s) => (
            <TerminalPane key={s.id} session={s} active={s.id === current?.id} />
          ))}
          {searchOpen && current && (
            <div className="term-search">
              <Search size={13} className="faint" />
              <input
                autoFocus
                value={query}
                placeholder={t('Find in terminal')}
                onChange={(e) => {
                  setQuery(e.target.value);
                  searchTerminal(current.id, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') searchTerminal(current.id, query, e.shiftKey ? 'prev' : 'next');
                  if (e.key === 'Escape') {
                    setSearchOpen(false);
                    clearSearch(current.id);
                    focusTerminal(current.id);
                  }
                }}
              />
              <IconButton label={t('Previous')} small onClick={() => searchTerminal(current.id, query, 'prev')}>
                <ChevronUp size={13} />
              </IconButton>
              <IconButton label={t('Next')} small onClick={() => searchTerminal(current.id, query, 'next')}>
                <ChevronDown size={13} />
              </IconButton>
              <IconButton
                label={t('Close')}
                small
                onClick={() => {
                  setSearchOpen(false);
                  clearSearch(current.id);
                }}
              >
                <X size={13} />
              </IconButton>
            </div>
          )}
        </div>
        {drawer && <SnippetDrawer sessionId={current?.state === 'connected' ? current.id : undefined} onClose={() => setDrawer(false)} />}
      </div>
    </>
  );
}
