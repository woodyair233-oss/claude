import { useMemo, useState } from 'react';
import { AlertTriangle, Folder, Import, LayoutGrid, List, MoreHorizontal, Plus, Server, Sparkles, Star, SquareTerminal } from 'lucide-react';
import type { ConnStatus, Host } from '@shared/types';
import { useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { relativeTime } from '../lib/format';
import { HOST_COLOR_HEX } from '../lib/themes';
import { hostContextMenu, openTerminal } from '../lib/actions';
import { causeTitle, isBenignCause } from '../lib/conn';
import { Toolbar } from '../components/Toolbar';
import { Button, EmptyState, IconButton, SearchField, Segmented } from '../components/ui';
import { ModeBadge } from '../components/domain';
import { ImportDialog } from './ImportDialog';

type Filter = 'all' | 'favorites' | 'connected' | 'ai';

function initials(h: Host) {
  const src = (h.name || h.alias).trim();
  const parts = src.split(/[\s\-_.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}

function HostAvatar({ host, size = 36 }: { host: Host; size?: number }) {
  const c = HOST_COLOR_HEX[host.color] ?? HOST_COLOR_HEX.blue;
  return (
    <div className="host-avatar" style={{ width: size, height: size, background: `linear-gradient(145deg, ${c}, color-mix(in srgb, ${c} 70%, #000))` }}>
      {initials(host)}
    </div>
  );
}

/** The latest attempt for a host, when it is worth flagging: it failed, or the connection dropped. */
function useConnProblem(host: Host, connected: boolean | undefined): ConnStatus | undefined {
  const st = useApp((s) => s.snap?.connStatus?.[host.id]);
  if (connected || !st) return undefined;
  // A prompt the user closed, or Gatehouse quitting mid-connect, is not a host problem.
  if (st.outcome === 'failed') return isBenignCause(st.cause) ? undefined : st;
  return st.dropped ? st : undefined;
}

function ConnProblem({ host, st }: { host: Host; st: ConnStatus }) {
  const text = st.outcome === 'failed' ? causeTitle(st.cause, st.causeParams) : t('The connection was lost');
  return (
    <button
      type="button"
      className={`conn-problem ${st.outcome === 'failed' ? '' : 'warn'}`}
      title={`${text} · ${t('View details')}`}
      onClick={(e) => {
        e.stopPropagation();
        useApp.getState().openConnLog(host.id, st.attemptId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <AlertTriangle size={11} />
      <span className="ellipsis">{text}</span>
    </button>
  );
}

function HostCard({ host }: { host: Host }) {
  const connected = useApp((s) => s.snap?.connectedHostIds.includes(host.id));
  const problem = useConnProblem(host, connected);
  const privacy = useApp((s) => s.snap?.settings.privacyMode);
  const openEditor = useApp((s) => s.openHostEditor);
  return (
    <div
      className="host-card"
      onDoubleClick={() => void openTerminal(host.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        void hostContextMenu(host);
      }}
    >
      <div className="hc-top">
        <HostAvatar host={host} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="hc-name ellipsis">
            {host.name || host.alias}
            {host.favorite && <Star size={12} className="fav-star" fill="currentColor" />}
          </div>
          <div className={`hc-addr mono ellipsis ${privacy ? 'privacy-blur' : ''}`}>
            {host.username ? `${host.username}@` : ''}
            {host.hostname}
            {host.port !== 22 ? `:${host.port}` : ''}
          </div>
        </div>
        <span
          className={`status-dot ${connected ? 'on' : problem?.outcome === 'failed' ? 'err' : ''}`}
          title={connected ? t('Connected') : problem?.outcome === 'failed' ? t('Last connection failed') : t('Not connected')}
        />
      </div>
      <div className="hc-meta">
        <ModeBadge mode={host.ai.mode} small />
        {host.ai.mode !== 'off' && (
          <span className="ai-alias mono" title={t('The only name Claude sees for this host')}>
            <Sparkles size={10} />
            {host.alias}
          </span>
        )}
        {host.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="chip">
            {tag}
          </span>
        ))}
      </div>
      <div className="hc-foot">
        <span className="hc-foot-text ellipsis">
          {host.group && (
            <span className="hc-group">
              <Folder size={11} />
              {host.group}
              <span className="faint">·</span>
            </span>
          )}
          {problem ? <ConnProblem host={host} st={problem} /> : (host.osInfo ?? (host.lastConnectedAt ? t('Last connected {when}', { when: relativeTime(host.lastConnectedAt) }) : t('Never connected')))}
        </span>
        <div className="hc-actions">
          <IconButton label={t('More')} small onClick={() => void hostContextMenu(host)}>
            <MoreHorizontal size={14} />
          </IconButton>
          <Button size="sm" variant="secondary" onClick={() => openEditor(host.id)}>
            {t('Edit')}
          </Button>
          <Button size="sm" variant="primary" icon={<SquareTerminal size={13} />} onClick={() => void openTerminal(host.id)}>
            {t('Connect')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function HostRow({ host }: { host: Host }) {
  const connected = useApp((s) => s.snap?.connectedHostIds.includes(host.id));
  const problem = useConnProblem(host, connected);
  const privacy = useApp((s) => s.snap?.settings.privacyMode);
  const openEditor = useApp((s) => s.openHostEditor);
  return (
    <tr
      className="clickable"
      onDoubleClick={() => void openTerminal(host.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        void hostContextMenu(host);
      }}
    >
      <td>
        <div className="row">
          <HostAvatar host={host} size={26} />
          <div style={{ minWidth: 0 }}>
            <div className="ellipsis" style={{ fontWeight: 550 }}>
              {host.name || host.alias} {host.favorite && <Star size={11} className="fav-star" fill="currentColor" />}
            </div>
            <div className="mono faint ellipsis" style={{ fontSize: 11 }}>
              {host.alias}
            </div>
          </div>
        </div>
      </td>
      <td className={`mono muted ${privacy ? 'privacy-blur' : ''}`}>
        {host.username ? `${host.username}@` : ''}
        {host.hostname}
        {host.port !== 22 ? `:${host.port}` : ''}
      </td>
      <td>
        <ModeBadge mode={host.ai.mode} small />
      </td>
      <td className="muted">{host.group || '—'}</td>
      <td>
        {problem ? (
          <ConnProblem host={host} st={problem} />
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <span className={`status-dot ${connected ? 'on' : ''}`} />
            <span className="faint">{connected ? t('Connected') : relativeTime(host.lastConnectedAt)}</span>
          </span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
          <IconButton label={t('Edit')} small onClick={() => openEditor(host.id)}>
            <MoreHorizontal size={14} />
          </IconButton>
          <Button size="sm" variant="primary" onClick={() => void openTerminal(host.id)}>
            {t('Connect')}
          </Button>
        </div>
      </td>
    </tr>
  );
}

export function HostsView() {
  const hosts = useApp((s) => s.snap!.hosts);
  const connectedIds = useApp((s) => s.snap!.connectedHostIds);
  const openEditor = useApp((s) => s.openHostEditor);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [layout, setLayout] = useState<'grid' | 'list'>(() => (localStorage.getItem('hosts.layout') as 'grid' | 'list') || 'grid');
  const [importing, setImporting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return hosts
      .filter((h) => (filter === 'favorites' ? h.favorite : filter === 'connected' ? connectedIds.includes(h.id) : filter === 'ai' ? h.ai.mode !== 'off' : true))
      .filter((h) => !q || [h.name, h.alias, h.hostname, h.username, h.group, ...h.tags, h.osInfo ?? ''].some((s) => s.toLowerCase().includes(q)))
      .sort(
        (a, b) =>
          Number(b.favorite) - Number(a.favorite) ||
          (a.group || '\uffff').localeCompare(b.group || '\uffff') ||
          (a.name || a.alias).localeCompare(b.name || b.alias),
      );
  }, [hosts, query, filter, connectedIds]);

  const setLayoutPersist = (l: 'grid' | 'list') => {
    setLayout(l);
    localStorage.setItem('hosts.layout', l);
  };

  return (
    <>
      <Toolbar title={t('Hosts')} subtitle={hosts.length ? t('{n} saved', { n: hosts.length }) : undefined}>
        {hosts.length > 0 && (
          <>
            <SearchField value={query} onChange={setQuery} placeholder={t('Filter hosts')} width={200} />
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('All') },
                { value: 'favorites', label: t('Favorites') },
                { value: 'connected', label: t('Connected') },
                { value: 'ai', label: t('AI-enabled') },
              ]}
            />
            <Segmented
              value={layout}
              onChange={setLayoutPersist}
              options={[
                { value: 'grid', label: '', icon: <LayoutGrid size={13} />, title: t('Grid') },
                { value: 'list', label: '', icon: <List size={13} />, title: t('List') },
              ]}
            />
          </>
        )}
        <Button icon={<Import size={14} />} onClick={() => setImporting(true)}>
          {t('Import')}
        </Button>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => openEditor()}>
          {t('New Host')}
        </Button>
      </Toolbar>
      <div className="content">
        {hosts.length === 0 ? (
          <EmptyState
            icon={<Server size={40} strokeWidth={1.5} />}
            title={t('Add your first server')}
            actions={
              <>
                <Button size="lg" icon={<Import size={15} />} onClick={() => setImporting(true)}>
                  {t('Import from ~/.ssh/config')}
                </Button>
                <Button size="lg" variant="primary" icon={<Plus size={15} />} onClick={() => openEditor()}>
                  {t('New Host')}
                </Button>
              </>
            }
          >
            {t('Gatehouse keeps your SSH hosts and credentials encrypted on this Mac. You decide, per host, what Claude may do.')}
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Server size={36} strokeWidth={1.5} />} title={t('No matching hosts')}>
            {t('Try a different search or filter.')}
          </EmptyState>
        ) : (
          <div className="page">
            {layout === 'grid' ? (
              <div className="host-grid">
                {filtered.map((h) => (
                  <HostCard key={h.id} host={h} />
                ))}
              </div>
            ) : (
              <div className="card" style={{ overflow: 'hidden' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('Name')}</th>
                      <th>{t('Address')}</th>
                      <th>{t('AI access')}</th>
                      <th>{t('Group')}</th>
                      <th>{t('Status')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((h) => (
                      <HostRow key={h.id} host={h} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}
