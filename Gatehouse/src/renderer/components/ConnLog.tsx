// The connection log: why a connection failed, what to try, and every step it took.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronRight, Circle, CircleSlash, Copy, Pencil, RotateCw, Route, Stethoscope, Trash2, Unplug, X, XCircle } from 'lucide-react';
import type { ConnAttempt } from '@shared/types';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { formatDateTime, formatDuration, relativeTime } from '../lib/format';
import { attemptHeadline, buildReport, causeHints, editorTabFor, isBenignCause, stepShowsAddress, stepText } from '../lib/conn';
import { Modal, ModalHeader } from './overlays';
import { Badge, Button, EmptyState, Spinner } from './ui';

type Tone = 'red' | 'amber' | 'green' | 'blue' | 'gray';

function toneOf(a: ConnAttempt): Tone {
  if (a.outcome === 'connecting') return 'blue';
  if (a.outcome === 'failed') return isBenignCause(a.cause) ? 'gray' : 'red';
  return a.endCause === 'dropped' ? 'amber' : 'green';
}

function StatusIcon({ a }: { a: ConnAttempt }) {
  switch (toneOf(a)) {
    case 'blue':
      return <Spinner />;
    case 'red':
      return <XCircle size={15} className="cl-red" />;
    case 'gray':
      return <CircleSlash size={15} className="cl-gray" />;
    case 'amber':
      return <AlertTriangle size={15} className="cl-amber" />;
    default:
      return <CheckCircle2 size={15} className="cl-green" />;
  }
}

function Verdict({
  a,
  privacy,
  onRetry,
  retrying,
  onEdit,
  onJump,
}: {
  a: ConnAttempt;
  privacy: boolean;
  onRetry?: () => void;
  retrying: boolean;
  onEdit?: () => void;
  onJump?: () => void;
}) {
  const failed = a.outcome === 'failed';
  const dropped = a.outcome === 'connected' && a.endCause === 'dropped';
  const tone = toneOf(a);
  const hints = failed ? causeHints(a.cause, a.causeParams) : dropped ? causeHints('dropped') : [];
  const actions = a.outcome !== 'connecting' && (onRetry || onEdit || onJump);
  return (
    <div className={`cl-verdict ${tone}`}>
      <div className="cl-verdict-head">
        <div className="cl-verdict-icon">
          {tone === 'red' ? <Unplug size={18} /> : tone === 'gray' ? <CircleSlash size={18} /> : dropped ? <AlertTriangle size={18} /> : a.outcome === 'connecting' ? <Spinner /> : <Check size={18} />}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="cl-verdict-title">{attemptHeadline(a)}</div>
          {failed && a.cause === 'unknown' && a.error && <div className={`cl-verdict-detail mono ${privacy ? 'privacy-blur' : ''}`}>{a.error}</div>}
          <div className="cl-verdict-meta">
            <span>{formatDateTime(a.startedAt)}</span>
            {a.durationMs !== undefined && a.durationMs >= 1 && <span>{t('took {duration}', { duration: formatDuration(a.durationMs) })}</span>}
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
      {actions && (
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

const STEP_STATUS_LABEL: Record<'ok' | 'fail' | 'info', string> = {
  ok: 'Done',
  fail: 'Problem',
  info: 'Note',
};

function Timeline({ a, privacy }: { a: ConnAttempt; privacy: boolean }) {
  return (
    <ol className="cl-steps">
      {a.steps.map((s, i) => (
        <li key={i} className={`cl-step ${s.status}`}>
          <span className="cl-step-at mono">+{formatDuration(s.at)}</span>
          <span className="cl-step-mark" role="img" aria-label={t(STEP_STATUS_LABEL[s.status])}>
            {s.status === 'ok' ? <Check size={12} /> : s.status === 'fail' ? <X size={12} /> : <Circle size={6} fill="currentColor" />}
          </span>
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
  const toast = useApp((s) => s.toast);
  const snap = useApp((s) => s.snap!);
  const status = useApp((s) => (req ? s.snap?.connStatus[req.hostId] : undefined));
  const host = req ? snap.hosts.find((h) => h.id === req.hostId) : undefined;
  const fromHost = req?.from ? snap.hosts.find((h) => h.id === req.from!.hostId) : undefined;

  const [list, setList] = useState<ConnAttempt[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detail, setDetail] = useState<ConnAttempt | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [withAddress, setWithAddress] = useState(false);
  const [copied, setCopied] = useState(false);

  const hostId = req?.hostId;
  const openedAt = req?.at;

  // Each opening starts afresh: the requested attempt, and addresses hidden in copies.
  useEffect(() => {
    setList(null);
    setDetail(null);
    setSelectedId(req?.attemptId);
    setWithAddress(false);
  }, [req?.hostId, req?.attemptId, openedAt]);

  const refresh = useCallback(async () => {
    if (!hostId) return;
    try {
      const items = await api().connLog.list(hostId);
      setList(items);
      setSelectedId((cur) => (cur && items.some((x) => x.id === cur) ? cur : items[0]?.id));
    } catch {
      setList([]);
    }
  }, [hostId]);

  // Reload on every opening and when this host's latest attempt changes.
  useEffect(() => {
    void refresh();
  }, [refresh, openedAt, status?.attemptId, status?.outcome, status?.dropped]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const a = await api().connLog.get(selectedId);
        if (alive) setDetail(a);
        return a;
      } catch {
        return null;
      }
    };
    void load();
    // Follow an attempt that is still in progress.
    const timer = setInterval(() => {
      void load().then((a) => {
        if (!a || a.outcome !== 'connecting') clearInterval(timer);
      });
    }, 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedId, status?.outcome]);

  // Never stay open (and keep polling) behind the lock screen.
  useEffect(() => {
    if (req && snap.uiLocked) close();
  }, [req, snap.uiLocked, close]);

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
      if (r.ok) toast({ kind: 'success', title: t('Connected to {name}', { name: host?.name || host?.alias || '' }), message: r.osInfo });
      else if (!r.attemptId) toast({ kind: 'error', title: t('Connection failed'), message: r.message });
    } catch (err) {
      toast({ kind: 'error', title: t('Connection failed'), message: (err as Error).message });
    } finally {
      setRetrying(false);
    }
  };

  const editTab = editorTabFor(detail?.outcome === 'failed' ? detail.cause : detail?.endCause === 'dropped' ? 'dropped' : undefined);
  const edit = () => {
    if (!hostId || !editTab) return;
    close();
    openEditor(hostId, editTab);
  };

  const copy = async () => {
    try {
      await api().app.clipboardWrite(report);
      setCopied(true);
    } catch (err) {
      toast({ kind: 'error', title: t('Could not copy'), message: (err as Error).message });
    }
  };

  const clear = async () => {
    if (!hostId) return;
    try {
      await api().connLog.clear(hostId);
      await refresh();
    } catch (err) {
      toast({ kind: 'error', title: t('Could not clear the history'), message: (err as Error).message });
    }
  };

  const privacy = snap.settings.privacyMode;
  const label = host ? host.name || host.alias : (detail?.hostLabel ?? '');
  const jumpTarget = (detail?.cause === 'jump' || detail?.cause === 'jump-forward') && detail.viaHostId && snap.hosts.some((h) => h.id === detail.viaHostId) ? detail.viaHostId : undefined;
  const headerTone = status?.outcome === 'failed' && !isBenignCause(status.cause) ? 'red' : status?.dropped ? 'amber' : 'green';

  return (
    <Modal onClose={close} size="xl" className="connlog-modal">
      <ModalHeader
        icon={<Stethoscope size={19} />}
        tone={headerTone}
        title={t('Connection log')}
        subtitle={host ? `${label} · ${host.alias}` : label}
        onClose={close}
      />
      {req.from && fromHost && (
        <div className="cl-back">
          <button type="button" className="link-btn" onClick={() => openConnLog(req.from!.hostId, req.from!.attemptId)}>
            <ArrowLeft size={12} />
            {t('Back to {name}', { name: fromHost.name || fromHost.alias })}
          </button>
        </div>
      )}
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
              <button
                key={a.id}
                type="button"
                className={`cl-item ${a.id === selectedId ? 'active' : ''}`}
                aria-current={a.id === selectedId ? 'true' : undefined}
                onClick={() => setSelectedId(a.id)}
              >
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
                  privacy={privacy}
                  // A deleted host can no longer be retried or edited; its log stays readable.
                  onRetry={host ? () => void retry() : undefined}
                  retrying={retrying}
                  onEdit={host && editTab ? edit : undefined}
                  onJump={jumpTarget ? () => openConnLog(jumpTarget, undefined, { hostId: req.hostId, attemptId: detail.id }) : undefined}
                />
                <div className="cl-section-title">{t('Connection steps')}</div>
                <Timeline a={detail} privacy={privacy} />
                {(detail.error || (detail.log && detail.log.length > 0)) && (
                  <details className="cl-raw">
                    <summary>
                      {t('Technical details')}
                      {detail.log?.length ? <Badge small>{t('{n} lines', { n: detail.log.length })}</Badge> : null}
                    </summary>
                    {detail.error && <div className={`cl-raw-error mono ${privacy ? 'privacy-blur' : ''}`}>{detail.error}</div>}
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
