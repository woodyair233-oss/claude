// The connection log: why a connection failed, what to try, and every step it took.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, ChevronRight, Circle, Copy, Pencil, RotateCw, Route, Stethoscope, Trash2, Unplug, X, XCircle } from 'lucide-react';
import type { ConnAttempt } from '@shared/types';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { formatDateTime, formatDuration, relativeTime } from '../lib/format';
import { attemptHeadline, buildReport, causeHints, editorTabFor, stepShowsAddress, stepText } from '../lib/conn';
import { Modal, ModalHeader } from './overlays';
import { Badge, Button, EmptyState, Spinner } from './ui';

function StatusIcon({ a }: { a: ConnAttempt }) {
  if (a.outcome === 'connecting') return <Spinner />;
  if (a.outcome === 'failed') return <XCircle size={15} className="cl-red" />;
  if (a.endCause === 'dropped') return <AlertTriangle size={15} className="cl-amber" />;
  return <CheckCircle2 size={15} className="cl-green" />;
}

function Verdict({ a, onRetry, retrying, onEdit, onJump }: { a: ConnAttempt; onRetry?: () => void; retrying: boolean; onEdit?: () => void; onJump?: () => void }) {
  const failed = a.outcome === 'failed';
  const dropped = a.outcome === 'connected' && a.endCause === 'dropped';
  const tone = failed ? 'red' : dropped ? 'amber' : a.outcome === 'connecting' ? 'blue' : 'green';
  const hints = failed ? causeHints(a.cause, a.causeParams) : dropped ? causeHints('dropped') : [];
  return (
    <div className={`cl-verdict ${tone}`}>
      <div className="cl-verdict-head">
        <div className="cl-verdict-icon">
          {failed ? <Unplug size={18} /> : dropped ? <AlertTriangle size={18} /> : a.outcome === 'connecting' ? <Spinner /> : <Check size={18} />}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="cl-verdict-title">{attemptHeadline(a)}</div>
          <div className="cl-verdict-meta">
            <span>{formatDateTime(a.startedAt)}</span>
            {a.durationMs !== undefined && <span>{t('took {duration}', { duration: formatDuration(a.durationMs) })}</span>}
            <span>{a.initiatedBy === 'ai' ? t('Started by Claude') : t('Started by you')}</span>
            {a.via && <span>{t('Through jump host {jump}', { jump: a.via })}</span>}
            {a.server && <span className="mono">{a.server}</span>}
          </div>
        </div>
      </div>
      {hints.length > 0 && (
        <div className="cl-hints">
          <div className="cl-hints-title">{t('What you can do')}</div>
          <ul>
            {hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      {a.outcome !== 'connecting' && (onRetry || onJump) && (
        <div className="cl-verdict-actions">
          {onRetry && (
            <Button size="sm" variant={failed ? 'primary' : 'secondary'} icon={<RotateCw size={13} />} loading={retrying} onClick={onRetry}>
              {t('Try again')}
            </Button>
          )}
          {onEdit && (failed || dropped) && (
            <Button size="sm" icon={<Pencil size={13} />} onClick={onEdit}>
              {t('Edit host')}
            </Button>
          )}
          {onJump && (
            <Button size="sm" icon={<Route size={13} />} onClick={onJump}>
              {t('Open the jump host\'s log')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Timeline({ a, privacy }: { a: ConnAttempt; privacy: boolean }) {
  return (
    <ol className="cl-steps">
      {a.steps.map((s, i) => (
        <li key={i} className={`cl-step ${s.status}`}>
          <span className="cl-step-at mono">+{formatDuration(s.at)}</span>
          <span className="cl-step-mark">{s.status === 'ok' ? <Check size={12} /> : s.status === 'fail' ? <X size={12} /> : <Circle size={6} fill="currentColor" />}</span>
          <span className={`cl-step-text ${privacy && stepShowsAddress(s) ? 'privacy-blur' : ''}`}>{stepText(s, a)}</span>
        </li>
      ))}
    </ol>
  );
}

export function ConnLogDialog() {
  const req = useApp((s) => s.connLog);
  const close = useApp((s) => s.closeConnLog);
  const openConnLog = useApp((s) => s.openConnLog);
  const openEditor = useApp((s) => s.openHostEditor);
  const snap = useApp((s) => s.snap!);
  const status = useApp((s) => (req ? s.snap?.connStatus[req.hostId] : undefined));
  const host = req ? snap.hosts.find((h) => h.id === req.hostId) : undefined;

  const [list, setList] = useState<ConnAttempt[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detail, setDetail] = useState<ConnAttempt | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [withAddress, setWithAddress] = useState(false);
  const [copied, setCopied] = useState(false);

  const hostId = req?.hostId;

  // A new request (another host, or a specific attempt) resets the view.
  useEffect(() => {
    setList(null);
    setDetail(null);
    setSelectedId(req?.attemptId);
  }, [req?.hostId, req?.attemptId, req?.at]);

  const refresh = useCallback(async () => {
    if (!hostId) return;
    const items = await api().connLog.list(hostId);
    setList(items);
    setSelectedId((cur) => (cur && items.some((x) => x.id === cur) ? cur : items[0]?.id));
  }, [hostId]);

  // Reload when this host's latest attempt changes (a new attempt, or one finishing).
  useEffect(() => {
    void refresh();
  }, [refresh, status?.attemptId, status?.outcome, status?.dropped]);

  useEffect(() => {
    if (!selectedId) return setDetail(null);
    let alive = true;
    const load = async () => {
      const a = await api().connLog.get(selectedId);
      if (alive) setDetail(a);
      return a;
    };
    void load();
    // Follow an attempt that is still in progress.
    const timer = setInterval(() => {
      void load().then((a) => {
        if (a && a.outcome !== 'connecting') clearInterval(timer);
      });
    }, 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedId, status?.outcome]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const report = useMemo(
    () => (detail ? buildReport(detail, { includeAddresses: withAddress, appVersion: snap.appVersion, platform: snap.platform }) : ''),
    [detail, withAddress, snap.appVersion, snap.platform],
  );

  if (!req) return null;

  const retry = async () => {
    if (!hostId) return;
    setRetrying(true);
    try {
      const r = await api().hosts.test(hostId);
      await refresh();
      if (r.attemptId) setSelectedId(r.attemptId);
      else if (r.ok) useApp.getState().toast({ kind: 'success', title: t('Connected to {name}', { name: host?.name || host?.alias || '' }), message: r.osInfo });
      else useApp.getState().toast({ kind: 'error', title: t('Connection failed'), message: r.message });
    } catch (err) {
      useApp.getState().toast({ kind: 'error', title: t('Connection failed'), message: (err as Error).message });
    } finally {
      setRetrying(false);
    }
  };

  const edit = () => {
    if (!hostId) return;
    close();
    openEditor(hostId, editorTabFor(detail?.outcome === 'failed' ? detail.cause : 'dropped'));
  };

  const copy = async () => {
    await api().app.clipboardWrite(report);
    setCopied(true);
  };

  const clear = async () => {
    if (!hostId) return;
    await api().connLog.clear(hostId);
    await refresh();
  };

  const privacy = snap.settings.privacyMode;
  const label = host ? host.name || host.alias : (detail?.hostLabel ?? '');
  const jumpTarget = detail?.cause === 'jump' && detail.viaHostId && snap.hosts.some((h) => h.id === detail.viaHostId) ? detail.viaHostId : undefined;

  return (
    <Modal onClose={close} size="xl" className="connlog-modal">
      <ModalHeader
        icon={<Stethoscope size={19} />}
        tone={status?.outcome === 'failed' ? 'red' : status?.dropped ? 'amber' : 'green'}
        title={t('Connection log')}
        subtitle={host ? `${label} · ${host.alias}` : label}
        onClose={close}
      />
      {list === null ? (
        <div className="cl-loading">
          <Spinner large />
        </div>
      ) : list.length === 0 ? (
        <div className="modal-body">
          <EmptyState icon={<Stethoscope size={34} />} title={t('No connection attempts yet')}>
            {t('Each time Gatehouse connects to this host, the steps and any problem are recorded here.')}
          </EmptyState>
        </div>
      ) : (
        <div className="cl-body">
          <nav className="cl-list" aria-label={t('Recent attempts')}>
            {list.map((a) => (
              <button key={a.id} type="button" className={`cl-item ${a.id === selectedId ? 'active' : ''}`} onClick={() => setSelectedId(a.id)}>
                <StatusIcon a={a} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="cl-item-title ellipsis">{attemptHeadline(a)}</span>
                  <span className="cl-item-meta ellipsis">
                    {relativeTime(a.startedAt)} · {a.initiatedBy === 'ai' ? 'Claude' : t('You')}
                  </span>
                </span>
                <ChevronRight size={13} className="cl-item-chev" />
              </button>
            ))}
          </nav>
          <section className="cl-detail">
            {!detail ? (
              <div className="cl-loading">
                <Spinner />
              </div>
            ) : (
              <>
                <Verdict
                  a={detail}
                  // A deleted host can no longer be retried or edited; its log stays readable.
                  onRetry={host ? () => void retry() : undefined}
                  retrying={retrying}
                  onEdit={host ? edit : undefined}
                  onJump={jumpTarget ? () => openConnLog(jumpTarget) : undefined}
                />
                <div className="cl-section-title">{t('Connection steps')}</div>
                <Timeline a={detail} privacy={privacy} />
                {(detail.error || (detail.log && detail.log.length > 0)) && (
                  <details className="cl-raw">
                    <summary>
                      {t('Technical details')}
                      {detail.log?.length ? <Badge small>{t('{n} lines', { n: detail.log.length })}</Badge> : null}
                    </summary>
                    {detail.error && <div className="cl-raw-error mono">{detail.error}</div>}
                    {detail.log && detail.log.length > 0 && <pre className={`code cl-raw-log ${privacy ? 'privacy-blur' : ''}`}>{detail.log.join('\n')}</pre>}
                  </details>
                )}
              </>
            )}
          </section>
        </div>
      )}
      <div className="modal-footer cl-footer">
        <label className="cl-check">
          <input type="checkbox" checked={withAddress} onChange={(e) => setWithAddress(e.target.checked)} />
          <span>{t('Include the server address and username when copying')}</span>
        </label>
        <div className="spacer" />
        {list && list.length > 0 && (
          <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void clear()}>
            {t('Clear history')}
          </Button>
        )}
        <Button icon={copied ? <Check size={14} /> : <Copy size={14} />} disabled={!detail} onClick={() => void copy()}>
          {copied ? t('Copied') : t('Copy report')}
        </Button>
        <Button variant="primary" onClick={close}>
          {t('Done')}
        </Button>
      </div>
    </Modal>
  );
}
