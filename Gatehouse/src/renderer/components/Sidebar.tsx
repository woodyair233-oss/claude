import { Activity, ClipboardCheck, FileClock, FolderTree, KeyRound, LayoutDashboard, Network, Search, Server, Settings, ShieldHalf, SlidersHorizontal, SquareTerminal, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApp, type ViewId, api } from '../lib/store';
import { t } from '../lib/i18n';
import { Logo } from './domain';
import { Kbd, Switch } from './ui';

function NavItem({ view, icon, label, right, ai }: { view: ViewId; icon: ReactNode; label: string; right?: ReactNode; ai?: boolean }) {
  const active = useApp((s) => s.view === view);
  const go = useApp((s) => s.go);
  return (
    <button className={`nav-item no-drag ${active ? 'active' : ''} ${ai ? 'ai' : ''}`} onClick={() => go(view)} aria-current={active ? 'page' : undefined}>
      {icon}
      <span className="ellipsis">{label}</span>
      {right}
    </button>
  );
}

export function Sidebar() {
  const snap = useApp((s) => s.snap)!;
  const setPalette = useApp((s) => s.setPalette);
  const pending = snap.gateway.pending.length;
  const running = Object.values(snap.forwardStatus).filter((f) => f.state === 'running').length;
  const openTerms = snap.terminals.length;
  const enabled = snap.settings.ai.enabled;
  const clients = snap.gateway.sessions.filter((s) => s.clientName !== 'Gatehouse self-test').length;
  const isMac = snap.platform === 'darwin';

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        {!isMac && (
          <div className="row" style={{ gap: 9 }}>
            <Logo size={22} />
            <strong style={{ fontSize: 14 }}>Gatehouse</strong>
          </div>
        )}
      </div>
      <button className="sidebar-search no-drag" onClick={() => setPalette(true)}>
        <Search size={13} />
        <span>{t('Search or jump to…')}</span>
        <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>
      <nav className="sidebar-scroll">
        <div className="nav-section">{t('Workspace')}</div>
        <NavItem view="hosts" icon={<Server size={16} />} label={t('Hosts')} right={<span className="nav-count">{snap.hosts.length || ''}</span>} />
        <NavItem view="terminals" icon={<SquareTerminal size={16} />} label={t('Terminals')} right={openTerms ? <span className="nav-count">{openTerms}</span> : undefined} />
        <NavItem view="files" icon={<FolderTree size={16} />} label={t('Files')} />
        <NavItem view="tunnels" icon={<Network size={16} />} label={t('Tunnels')} right={running ? <span className="nav-count">{running}</span> : undefined} />
        <NavItem view="keys" icon={<KeyRound size={16} />} label={t('Keys')} />
        <NavItem view="snippets" icon={<Zap size={16} />} label={t('Snippets')} />

        <div className="nav-section">{t('AI Gateway')}</div>
        <NavItem view="gateway" ai icon={<LayoutDashboard size={16} />} label={t('Overview')} right={clients ? <span className="live-dot" title={t('{n} AI client(s) connected', { n: clients })} /> : undefined} />
        <NavItem view="approvals" ai icon={<ClipboardCheck size={16} />} label={t('Approvals')} right={pending ? <span className="nav-badge">{pending}</span> : undefined} />
        <NavItem view="activity" ai icon={<Activity size={16} />} label={t('Activity')} />
        <NavItem view="policies" ai icon={<SlidersHorizontal size={16} />} label={t('Policies')} />
        <NavItem view="audit" ai icon={<FileClock size={16} />} label={t('Audit Log')} />
      </nav>
      <div className="sidebar-footer">
        <div className={`kill-switch no-drag ${enabled ? '' : 'paused'}`}>
          <div className="ks-icon">
            <ShieldHalf size={16} />
          </div>
          <div className="grow">
            <div className="ks-title">{enabled ? t('AI access on') : t('AI access paused')}</div>
            <div className="ks-sub ellipsis">{enabled ? (clients ? t('{n} client(s) connected', { n: clients }) : t('No AI clients connected')) : t('All AI requests are refused')}</div>
          </div>
          <Switch on={enabled} tone="green" label={t('AI access')} onChange={(v) => void api().gateway.setEnabled(v)} />
        </div>
        <NavItem view="settings" icon={<Settings size={16} />} label={t('Settings')} />
      </div>
    </aside>
  );
}
