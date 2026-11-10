import { useCallback, useEffect, useState } from 'react';
import { Download, FileClock, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import type { AuditEntry, AuditVerifyInfo } from '@shared/types';
import { api, attempt, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { formatDateTime, formatDuration } from '../lib/format';
import { Toolbar } from '../components/Toolbar';
import { Button, EmptyState, SearchField, Select, Spinner } from '../components/ui';
import { HostChip, OutcomeBadge, RiskBadge, TOOL_ICON, TOOL_LABEL } from '../components/domain';

const PAGE = 100;

export function AuditView() {
  const hosts = useApp((s) => s.snap!.hosts);
  const activityCount = useApp((s) => s.activity.length);
  const toast = useApp((s) => s.toast);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState('');
  const [host, setHost] = useState('');
  const [verify, setVerify] = useState<AuditVerifyInfo | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async () => {
    const r = await attempt(() => api().gateway.queryAudit({ limit, text: query || undefined, outcome: outcome || undefined, host: host || undefined }), t('Could not read the audit log'));
    if (r) {
      setEntries(r.entries);
      setTotal(r.total);
    }
  }, [limit, query, outcome, host]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 150);
    return () => clearTimeout(id);
  }, [load, activityCount]);

  const runVerify = async () => {
    setVerifying(true);
    setVerify((await attempt(() => api().gateway.verifyAudit(), t('Verification failed'))) ?? null);
    setVerifying(false);
  };
  useEffect(() => {
    void runVerify();
  }, []);

  const exportAs = async (format: 'json' | 'csv') => {
    const path = await attempt(() => api().gateway.exportAudit(format), t('Export failed'));
    if (path) toast({ kind: 'success', title: t('Audit log exported'), message: path });
  };

  return (
    <>
      <Toolbar title={t('Audit Log')} subtitle={t('{n} entries', { n: total })}>
        <SearchField value={query} onChange={setQuery} width={200} />
        <div className="no-drag" style={{ width: 140 }}>
          <Select
            value={outcome}
            onChange={setOutcome}
            options={[
              { value: '', label: t('All outcomes') },
              { value: 'auto', label: t('Auto-approved') },
              { value: 'approved', label: t('Approved') },
              { value: 'denied', label: t('Denied') },
              { value: 'blocked', label: t('Blocked') },
              { value: 'timeout', label: t('Timed out') },
              { value: 'error', label: t('Error') },
              { value: 'rate-limited', label: t('Rate limited') },
              { value: 'paused', label: t('Paused') },
            ]}
          />
        </div>
        <div className="no-drag" style={{ width: 140 }}>
          <Select value={host} onChange={setHost} options={[{ value: '', label: t('All hosts') }, ...hosts.map((h) => ({ value: h.alias, label: h.alias }))]} />
        </div>
        <Button icon={<Download size={14} />} onClick={() => void api().app.contextMenu([{ id: 'csv', label: 'CSV' }, { id: 'json', label: 'JSON' }]).then((f) => { if (f) void exportAs(f as 'csv' | 'json'); })}>
          {t('Export')}
        </Button>
      </Toolbar>
      <div className="content">
        <div className="page">
          <div className={`integrity ${verify ? (verify.ok ? 'ok' : 'bad') : ''}`}>
            {verifying ? <Spinner /> : verify?.ok ? <ShieldCheck size={18} /> : verify ? <ShieldX size={18} /> : <FileClock size={18} />}
            <div className="grow">
              <strong>
                {verifying
                  ? t('Verifying the hash chain…')
                  : verify?.ok
                    ? t('Integrity verified — {n} entries, chain intact', { n: verify.entries })
                    : verify
                      ? t('Tampering detected')
                      : t('Integrity not checked')}
              </strong>
              <div className="faint" style={{ fontSize: 12 }}>
                {verify && !verify.ok && verify.brokenAt
                  ? t('{file}, line {line}: {reason}', { file: verify.brokenAt.file, line: verify.brokenAt.line, reason: verify.brokenAt.reason })
                  : t('Each entry is chained to the previous one with SHA-256, so edits or deletions are detectable.')}
              </div>
            </div>
            <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void runVerify()} loading={verifying}>{t('Verify')}</Button>
          </div>

          {entries === null ? (
            <div className="row" style={{ justifyContent: 'center', padding: 60 }}><Spinner large /></div>
          ) : entries.length === 0 ? (
            <EmptyState icon={<FileClock size={38} strokeWidth={1.5} />} title={t('No audit entries')}>{t('Nothing matches, or Claude has not made any requests yet.')}</EmptyState>
          ) : (
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="table audit-table">
                <thead>
                  <tr>
                    <th>{t('Time')}</th>
                    <th>{t('Client')}</th>
                    <th>{t('Action')}</th>
                    <th>{t('Host')}</th>
                    <th>{t('Details')}</th>
                    <th>{t('Risk')}</th>
                    <th>{t('Outcome')}</th>
                    <th style={{ textAlign: 'right' }}>{t('Time taken')}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="faint tnum nowrap">{formatDateTime(e.ts)}</td>
                      <td className="ellipsis" style={{ maxWidth: 120 }}>{e.client}</td>
                      <td className="nowrap"><span className="row" style={{ gap: 5 }}>{TOOL_ICON[e.tool]}{t(TOOL_LABEL[e.tool] ?? e.tool)}</span></td>
                      <td>{e.hostAlias ? <HostChip alias={e.hostAlias} color={hosts.find((h) => h.id === e.hostId)?.color} /> : <span className="faint">—</span>}</td>
                      <td className="mono ellipsis selectable" style={{ maxWidth: 340 }} title={[e.command ?? e.path, e.shell && e.shell !== 'posix' ? `(${e.shell === 'wsl' ? 'WSL' : 'PowerShell'})` : '', e.userMessage && `“${e.userMessage}”`, e.error].filter(Boolean).join('\n')}>
                        {e.shell === 'powershell' ? <span className="faint">PS❯ </span> : e.shell === 'wsl' ? <span className="faint">WSL❯ </span> : null}
                        {e.command ?? e.path ?? e.error ?? ''}
                      </td>
                      <td>{e.risk && e.risk !== 'block' && e.tool !== 'list_hosts' && e.outcome !== 'blocked' ? <RiskBadge risk={e.risk} small /> : null}</td>
                      <td><OutcomeBadge outcome={e.outcome} small /></td>
                      <td className="faint tnum" style={{ textAlign: 'right' }}>{e.durationMs !== undefined ? formatDuration(e.durationMs) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > entries.length && (
                <div style={{ padding: 12, textAlign: 'center' }}>
                  <Button size="sm" onClick={() => setLimit((l) => l + PAGE)}>{t('Show more ({n} remaining)', { n: total - entries.length })}</Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
