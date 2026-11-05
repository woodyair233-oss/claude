import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronLeft, ChevronRight, Clock, FilePen, FileText, Fingerprint, MessageSquareX, Pencil, Quote, ShieldAlert, Terminal, Zap } from 'lucide-react';
import type { ApprovalDecision, ApprovalRequest, PolicyCause } from '@shared/types';
import { assessCommand } from '@shared/command-policy';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { formatBytes } from '../lib/format';
import { Button, Input, TextArea, useTicker } from './ui';
import { CountdownRing, HostChip, REASON_LABEL, RiskBadge, TokenText } from './domain';
import { Modal } from './overlays';

const CAUSE_TEXT: Record<PolicyCause, string> = {
  'mode-ask': 'This host asks before anything that changes state.',
  danger: 'Gatehouse classified this as high risk.',
  sensitive: 'This touches credential or secret files.',
  'file-write': 'Claude wants to write a file.',
  'read-only-sensitive': 'This read-only host still asks before reading secrets.',
  'system-path': 'This writes to a system location.',
};

function kindIcon(kind: ApprovalRequest['kind']) {
  if (kind === 'write-file') return <FilePen size={15} />;
  if (kind === 'read-file') return <FileText size={15} />;
  if (kind === 'snippet') return <Zap size={15} />;
  return <Terminal size={15} />;
}

function kindTitle(req: ApprovalRequest) {
  if (req.kind === 'write-file') return req.appendMode ? t('wants to append to a file on') : t('wants to write a file on');
  if (req.kind === 'read-file') return t('wants to read a file on');
  if (req.kind === 'snippet') return t('wants to run a snippet on');
  return t('wants to run a command on');
}

export function ApprovalCard({ req, autoFocus }: { req: ApprovalRequest; autoFocus?: boolean }) {
  useTicker(500);
  const snap = useApp((s) => s.snap!);
  const toast = useApp((s) => s.toast);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(req.command ?? '');
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [needsTyped, setNeedsTyped] = useState(req.requireTouchId && !snap.touchIdAvailable);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAi, setShowAi] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const remaining = req.expiresAt - Date.now();
  const total = req.expiresAt - req.createdAt;
  const host = snap.hosts.find((h) => h.id === req.hostId);
  const grantable = (req.kind === 'command' || req.kind === 'write-file') && req.cause !== 'danger' && req.cause !== 'sensitive' && req.cause !== 'system-path' && host?.ai.mode !== 'read-only';
  const editedAssessment = useMemo(() => (editing && edited.trim() ? assessCommand(edited) : null), [editing, edited]);

  useEffect(() => {
    if (autoFocus) cardRef.current?.querySelector<HTMLButtonElement>('.ac-allow')?.focus();
  }, [autoFocus, req.id]);

  const decide = async (decision: ApprovalDecision) => {
    setBusy(decision.action === 'allow' ? decision.scope : 'deny');
    try {
      const r = await api().gateway.decide(req.id, needsTyped && decision.action === 'allow' ? { ...decision, confirmText } : decision);
      if (!r.ok) {
        if (r.error === 'type-confirm-required') setNeedsTyped(true);
        else toast({ kind: 'error', title: t('Not approved'), message: r.error });
      }
    } finally {
      setBusy(null);
    }
  };

  const allow = (scope: 'once' | 'always' | 'grant') =>
    void decide({ action: 'allow', scope, ...(editing && edited.trim() && edited.trim() !== req.command ? { editedCommand: edited.trim() } : {}) });

  return (
    <div
      ref={cardRef}
      className={`approval-card ${req.assessment?.risk === 'danger' || req.cause === 'danger' ? 'is-danger' : ''}`}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !denying) {
          e.preventDefault();
          allow('once');
        }
      }}
    >
      <div className="ac-head">
        <div className="ac-kind">{kindIcon(req.kind)}</div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ac-title">
            <span className="ac-client"><Bot size={13} />{req.client.name}</span> {kindTitle(req)} <HostChip alias={req.hostAlias} color={req.hostColor} />
          </div>
          <div className="ac-sub">
            <RiskBadge risk={req.kind === 'write-file' ? 'write' : req.kind === 'read-file' ? 'read' : req.assessment?.risk} small />
            <span className="faint">{t(CAUSE_TEXT[req.cause])}</span>
          </div>
        </div>
        <CountdownRing remainingMs={remaining} totalMs={total} />
      </div>

      {req.reason && (
        <div className="ac-reason">
          <Quote size={13} />
          <div>
            <div>{req.reason}</div>
            <div className="ac-reason-note">{t('Written by the AI — judge the command itself, not the explanation.')}</div>
          </div>
        </div>
      )}

      {req.command !== undefined && (
        <div className="ac-block">
          <div className="ac-label">
            {req.kind === 'snippet' ? t('Snippet command') : t('Command')}
            {req.aiCommand && (
              <button className="link-btn" onClick={() => setShowAi((v) => !v)}>
                {showAi ? t('Show what will run') : t('Show what Claude sent')}
              </button>
            )}
            {req.kind === 'command' && !editing && (
              <button className="link-btn" onClick={() => setEditing(true)}>
                <Pencil size={11} /> {t('Edit before running')}
              </button>
            )}
          </div>
          {editing ? (
            <>
              <TextArea mono value={edited} onChange={(e) => setEdited(e.target.value)} rows={Math.min(8, edited.split('\n').length + 1)} autoFocus />
              {editedAssessment && (
                <div className="row" style={{ marginTop: 6 }}>
                  <RiskBadge risk={editedAssessment.risk} small />
                  <span className="faint" style={{ fontSize: 11.5 }}>{t('Claude will be told you edited the command.')}</span>
                </div>
              )}
            </>
          ) : (
            <pre className="code lg selectable">{showAi && req.aiCommand ? <TokenText text={req.aiCommand} /> : req.command}</pre>
          )}
        </div>
      )}

      {req.path && (
        <div className="ac-block">
          <div className="ac-label">{t('File')}</div>
          <pre className="code selectable">{req.path}</pre>
        </div>
      )}

      {req.contentPreview !== undefined && (
        <div className="ac-block">
          <div className="ac-label">
            {req.appendMode ? t('Content to append') : t('New content')} <span className="faint">· {formatBytes(req.contentBytes ?? 0)}</span>
          </div>
          <pre className="code selectable" style={{ maxHeight: 220 }}>{req.contentPreview}{(req.contentBytes ?? 0) > req.contentPreview.length ? '\n…' : ''}</pre>
        </div>
      )}

      {req.assessment && req.assessment.reasons.length > 0 && (
        <ul className="reason-list ac-reasons">
          {req.assessment.reasons.slice(0, 6).map((r, i) => (
            <li key={i} className={/danger|delete|destroy|power|lockout|firewall|tamper|exec|system/.test(r.code) ? 'danger' : ''}>
              {t(REASON_LABEL[r.code])}
              {r.detail && <span className="mono faint"> · {r.detail.length > 60 ? r.detail.slice(0, 57) + '…' : r.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {denying ? (
        <div className="ac-deny">
          <TextArea value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('Optional note for Claude, e.g. "Check the logs first" or "Use the staging server"')} rows={2} autoFocus />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <Button variant="ghost" onClick={() => setDenying(false)}>{t('Back')}</Button>
            <Button variant="danger" loading={busy === 'deny'} onClick={() => void decide({ action: 'deny', message })}>{t('Deny and send note')}</Button>
          </div>
        </div>
      ) : (
        <>
          {needsTyped && (
            <div className="ac-typed">
              <Fingerprint size={14} />
              <span>{t('Touch ID is unavailable. Type the host alias to approve:')}</span>
              <Input mono value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={req.hostAlias} style={{ width: 160 }} />
            </div>
          )}
          <div className="ac-actions">
            <Button variant="danger-soft" loading={busy === 'deny'} onClick={() => void decide({ action: 'deny' })}>{t('Deny')}</Button>
            <Button variant="ghost" icon={<MessageSquareX size={14} />} onClick={() => setDenying(true)}>{t('Deny with note…')}</Button>
            <div className="spacer" />
            {grantable && (
              <Button loading={busy === 'grant'} icon={<Clock size={13} />} onClick={() => allow('grant')} title={t('Auto-approve non-high-risk actions on this host for {n} minutes', { n: snap.settings.ai.grantMinutes })}>
                {t('Allow {n} min', { n: snap.settings.ai.grantMinutes })}
              </Button>
            )}
            {req.allowRemember && !editing && (
              <Button loading={busy === 'always'} onClick={() => allow('always')} title={t('Add this exact command to the host\'s allow list')}>
                {t('Always allow')}
              </Button>
            )}
            <Button className="ac-allow" variant="primary" loading={busy === 'once'} disabled={needsTyped && confirmText.trim().toLowerCase() !== req.hostAlias.toLowerCase()} icon={req.requireTouchId && snap.touchIdAvailable ? <Fingerprint size={14} /> : undefined} onClick={() => allow('once')}>
              {editing ? t('Run edited command') : t('Allow once')}
              <kbd className="btn-kbd">{navigator.platform.includes('Mac') ? '⌘↩' : 'Ctrl ↩'}</kbd>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Pops up for new approval requests unless the Approvals page is open. */
export function ApprovalModal() {
  const pending = useApp((s) => s.snap?.gateway.pending ?? []);
  const view = useApp((s) => s.view);
  const locked = useApp((s) => s.snap?.uiLocked);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [index, setIndex] = useState(0);
  const visible = pending.filter((p) => !dismissed.has(p.id));
  const req = visible[Math.min(index, visible.length - 1)];
  useEffect(() => {
    if (index >= visible.length) setIndex(Math.max(0, visible.length - 1));
  }, [visible.length, index]);
  if (!req || view === 'approvals' || locked) return null;
  return (
    <Modal onClose={() => setDismissed(new Set([...dismissed, ...visible.map((v) => v.id)]))} size="wide" className="approval-modal">
      <div className="am-top">
        <ShieldAlert size={15} color="var(--amber)" />
        <strong>{t('Approval needed')}</strong>
        {visible.length > 1 && (
          <div className="row" style={{ marginLeft: 'auto', gap: 4 }}>
            <button className="icon-btn sm" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label={t('Previous')}><ChevronLeft size={14} /></button>
            <span className="faint tnum" style={{ fontSize: 12 }}>{t('{i} of {n}', { i: Math.min(index, visible.length - 1) + 1, n: visible.length })}</span>
            <button className="icon-btn sm" disabled={index >= visible.length - 1} onClick={() => setIndex(index + 1)} aria-label={t('Next')}><ChevronRight size={14} /></button>
          </div>
        )}
        <span className={visible.length > 1 ? '' : 'spacer'} />
        <button className="link-btn" style={{ marginLeft: visible.length > 1 ? 10 : 0 }} onClick={() => setDismissed(new Set([...dismissed, ...visible.map((v) => v.id)]))}>
          {t('Later')} <kbd>esc</kbd>
        </button>
      </div>
      <div className="modal-body" style={{ paddingTop: 4 }}>
        <ApprovalCard key={req.id} req={req} autoFocus />
      </div>
    </Modal>
  );
}
