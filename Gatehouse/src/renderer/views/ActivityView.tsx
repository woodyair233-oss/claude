import { useMemo, useState } from 'react';
import { Activity, Bot, Eraser, KeyRound } from 'lucide-react';
import type { ActivityItem } from '@shared/types';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { formatBytes, formatDateTime, formatDuration, formatTime } from '../lib/format';
import { Toolbar } from '../components/Toolbar';
import { Button, CodeBlock, EmptyState, SearchField, Select } from '../components/ui';
import { HostChip, OutcomeBadge, RiskBadge, TOOL_ICON, TOOL_LABEL, TokenText } from '../components/domain';
import { Sheet } from '../components/overlays';

function statusKey(a: ActivityItem): Parameters<typeof OutcomeBadge>[0]['outcome'] {
  if (a.status === 'pending-approval') return 'pending';
  if (a.status === 'running') return 'running';
  return a.outcome;
}

function Detail({ item, onClose }: { item: ActivityItem; onClose: () => void }) {
  const hosts = useApp((s) => s.snap!.hosts);
  const host = hosts.find((h) => h.id === item.hostId);
  const [map, setMap] = useState<[string, string][] | null>(null);
  return (
    <Sheet onClose={onClose} title={t(TOOL_LABEL[item.tool] ?? item.tool)} icon={<span className="ac-kind">{TOOL_ICON[item.tool]}</span>} width={640}>
      <div className="detail-grid">
        <div className="faint">{t('When')}</div>
        <div>{formatDateTime(item.ts)}</div>
        <div className="faint">{t('Client')}</div>
        <div className="row" style={{ gap: 6 }}><Bot size={13} color="var(--violet)" />{item.client}</div>
        {item.hostAlias && (
          <>
            <div className="faint">{t('Host')}</div>
            <div><HostChip alias={item.hostAlias} color={host?.color} /></div>
          </>
        )}
        <div className="faint">{t('Outcome')}</div>
        <div className="row" style={{ gap: 6 }}>
          <OutcomeBadge outcome={statusKey(item)} />
          {item.decidedBy && <span className="faint">{t('by')} {t(item.decidedBy === 'user' ? 'you' : item.decidedBy === 'policy' ? 'policy' : item.decidedBy === 'allowlist' ? 'allow list' : item.decidedBy === 'grant' ? 'session grant' : 'trusted snippet')}</span>}
          {item.edited && <span className="badge amber sm">{t('edited by you')}</span>}
        </div>
        {item.risk && (
          <>
            <div className="faint">{t('Risk')}</div>
            <div><RiskBadge risk={item.risk} /></div>
          </>
        )}
        {item.exitCode !== undefined && item.exitCode !== null && (
          <>
            <div className="faint">{t('Exit code')}</div>
            <div className="mono">{item.exitCode}</div>
          </>
        )}
        {item.durationMs !== undefined && (
          <>
            <div className="faint">{t('Duration')}</div>
            <div>{formatDuration(item.durationMs)}{item.bytesOut ? ` · ${formatBytes(item.bytesOut)}` : ''}</div>
          </>
        )}
        {!!item.redactions && (
          <>
            <div className="faint">{t('Redacted')}</div>
            <div>{t('{n} value(s) hidden from Claude', { n: item.redactions })}</div>
          </>
        )}
      </div>
      {item.reason && (
        <>
          <div className="ac-label" style={{ marginTop: 18 }}>{t("Claude's reason")}</div>
          <div className="ac-reason" style={{ margin: 0 }}><div>{item.reason}</div></div>
        </>
      )}
      {item.command && (
        <>
          <div className="ac-label" style={{ marginTop: 18 }}>{t('Command')}</div>
          <CodeBlock code={item.command} />
        </>
      )}
      {item.path && (
        <>
          <div className="ac-label" style={{ marginTop: 18 }}>{t('Path')}</div>
          <CodeBlock code={item.path} />
        </>
      )}
      {item.userMessage && (
        <>
          <div className="ac-label" style={{ marginTop: 18 }}>{t('Your note to Claude')}</div>
          <div className="callout"><div>{item.userMessage}</div></div>
        </>
      )}
      {item.error && (
        <>
          <div className="ac-label" style={{ marginTop: 18 }}>{t('Details')}</div>
          <div className="callout red"><div className="selectable">{item.error}</div></div>
        </>
      )}
      {item.outputPreview && (
        <>
          <div className="ac-label" style={{ marginTop: 18 }}>{t('What Claude saw')} <span className="faint">({t('after redaction')})</span></div>
          <CodeBlock code={item.outputPreview}><TokenText text={item.outputPreview} /></CodeBlock>
        </>
      )}
      <div style={{ marginTop: 18 }}>
        {map === null ? (
          <Button size="sm" icon={<KeyRound size={13} />} onClick={() => void api().gateway.tokenMap().then(setMap)}>{t('Reveal placeholder values')}</Button>
        ) : map.length === 0 ? (
          <div className="faint">{t('No placeholders issued yet.')}</div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead><tr><th>{t('Placeholder')}</th><th>{t('Real value (only shown here)')}</th></tr></thead>
              <tbody>
                {map.map(([k, v]) => (
                  <tr key={k}><td className="mono"><span className="tok">{k}</span></td><td className="mono selectable">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Sheet>
  );
}

export function ActivityView() {
  const activity = useApp((s) => s.activity);
  const hosts = useApp((s) => s.snap!.hosts);
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState('');
  const [host, setHost] = useState('');
  const [open, setOpen] = useState<ActivityItem | null>(null);

  const list = useMemo(() => {
    const q = query.toLowerCase();
    return activity.filter(
      (a) =>
        (!outcome || (outcome === 'pending' ? a.status !== 'done' : a.status === 'done' && a.outcome === outcome)) &&
        (!host || a.hostAlias === host) &&
        (!q || [a.command, a.path, a.reason, a.hostAlias, a.client, a.tool].some((s) => s?.toLowerCase().includes(q))),
    );
  }, [activity, query, outcome, host]);

  const current = open ? activity.find((a) => a.id === open.id) ?? open : null;

  return (
    <>
      <Toolbar title={t('Activity')} subtitle={t('Live AI requests')}>
        <SearchField value={query} onChange={setQuery} width={200} />
        <div className="no-drag" style={{ width: 150 }}>
          <Select
            value={outcome}
            onChange={setOutcome}
            options={[
              { value: '', label: t('All outcomes') },
              { value: 'pending', label: t('In progress') },
              { value: 'auto', label: t('Auto-approved') },
              { value: 'approved', label: t('Approved') },
              { value: 'denied', label: t('Denied') },
              { value: 'blocked', label: t('Blocked') },
              { value: 'timeout', label: t('Timed out') },
              { value: 'error', label: t('Error') },
            ]}
          />
        </div>
        <div className="no-drag" style={{ width: 150 }}>
          <Select value={host} onChange={setHost} options={[{ value: '', label: t('All hosts') }, ...hosts.map((h) => ({ value: h.alias, label: h.alias }))]} />
        </div>
        <Button icon={<Eraser size={14} />} onClick={() => void api().gateway.clearActivity()} disabled={!activity.length}>{t('Clear')}</Button>
      </Toolbar>
      <div className="content">
        {activity.length === 0 ? (
          <EmptyState icon={<Activity size={40} strokeWidth={1.5} />} title={t('No AI activity yet')}>
            {t('Requests from Claude appear here in real time. The full history is in the audit log.')}
          </EmptyState>
        ) : (
          <div className="activity-list">
            {list.map((a) => {
              const h = hosts.find((x) => x.id === a.hostId);
              return (
                <button key={a.id} className={`activity-row ${a.status !== 'done' ? 'live' : ''}`} onClick={() => setOpen(a)}>
                  <span className="ar-time tnum faint">{formatTime(a.ts)}</span>
                  <span className="ar-tool" title={t(TOOL_LABEL[a.tool] ?? a.tool)}>{TOOL_ICON[a.tool]}</span>
                  {a.hostAlias ? <HostChip alias={a.hostAlias} color={h?.color} /> : <span className="faint" style={{ fontSize: 12 }}>{t(TOOL_LABEL[a.tool] ?? a.tool)}</span>}
                  <span className="ar-cmd mono ellipsis">{a.command ?? a.path ?? ''}</span>
                  {a.risk && a.risk !== 'block' && a.tool !== 'list_hosts' && !(a.outcome === 'blocked' && a.status === 'done') && <RiskBadge risk={a.risk} small />}
                  <OutcomeBadge outcome={statusKey(a)} small />
                  <span className="ar-meta tnum faint">{a.durationMs !== undefined ? formatDuration(a.durationMs) : ''}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {current && <Detail item={current} onClose={() => setOpen(null)} />}
    </>
  );
}
