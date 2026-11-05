import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { Button, Input, useAutofocus } from './ui';

function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, enabled]);
}

export function Modal({
  onClose,
  children,
  size,
  dismissable = true,
  className = '',
}: {
  onClose: () => void;
  children: ReactNode;
  size?: 'wide' | 'xl';
  dismissable?: boolean;
  className?: string;
}) {
  useEscape(onClose, dismissable);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''} ${className}`} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ModalHeader({ icon, tone, title, subtitle, onClose }: { icon?: ReactNode; tone?: 'amber' | 'red' | 'violet' | 'green'; title: ReactNode; subtitle?: ReactNode; onClose?: () => void }) {
  return (
    <div className="modal-header">
      {icon && <div className={`modal-icon ${tone ?? ''}`}>{icon}</div>}
      <div className="grow">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {onClose && (
        <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function Sheet({ onClose, title, icon, children, footer, tabs, width }: { onClose: () => void; title: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode; tabs?: ReactNode; width?: number }) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="sheet-overlay" onMouseDown={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, calc(100vw - 280px))` } : undefined}>
        <div className="sheet-header">
          {icon}
          <h2 className="grow">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </div>
        {tabs && <div className="sheet-tabs">{tabs}</div>}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return createPortal(
    <div className="toasts">
      {toasts.map((tt) => (
        <div key={tt.id} className={`toast ${tt.kind}`} onClick={() => dismiss(tt.id)}>
          {tt.kind === 'success' ? <CheckCircle2 size={17} /> : tt.kind === 'error' ? <XCircle size={17} /> : tt.kind === 'warning' ? <AlertTriangle size={17} /> : <Info size={17} />}
          <div className="grow">
            <div className="t-title">{tt.title}</div>
            {tt.message && <div className="t-msg">{tt.message}</div>}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------- confirm / prompt dialogs

interface DialogReq {
  kind: 'confirm' | 'prompt';
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  placeholder?: string;
  initial?: string;
  password?: boolean;
  requireText?: string;
  resolve: (v: string | boolean | null) => void;
}

const useDialogs = create<{ req: DialogReq | null; set: (r: DialogReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

export function confirmDialog(opts: Omit<DialogReq, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useDialogs.getState().set({ ...opts, kind: 'confirm', resolve: (v) => resolve(v === true) }));
}

export function promptDialog(opts: Omit<DialogReq, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => useDialogs.getState().set({ ...opts, kind: 'prompt', resolve: (v) => resolve(typeof v === 'string' ? v : null) }));
}

export function DialogHost() {
  const req = useDialogs((s) => s.req);
  const set = useDialogs((s) => s.set);
  const [value, setValue] = useState('');
  const inputRef = useAutofocus<HTMLInputElement>();
  useEffect(() => setValue(req?.initial ?? ''), [req]);
  if (!req) return null;
  const close = (v: string | boolean | null) => {
    set(null);
    req.resolve(v);
  };
  const canConfirm = req.kind === 'prompt' ? value.trim().length > 0 && (!req.requireText || value.trim() === req.requireText) : !req.requireText || value.trim() === req.requireText;
  const submit = () => {
    if (!canConfirm) return;
    close(req.kind === 'prompt' ? value : true);
  };
  return (
    <Modal onClose={() => close(req.kind === 'prompt' ? null : false)}>
      <ModalHeader icon={req.danger ? <AlertTriangle size={19} /> : <Info size={19} />} tone={req.danger ? 'red' : undefined} title={req.title} subtitle={req.message} />
      {(req.kind === 'prompt' || req.requireText) && (
        <div className="modal-body">
          {req.requireText && (
            <div className="hint" style={{ marginBottom: 6 }}>
              {t('Type {text} to confirm.', { text: req.requireText })}
            </div>
          )}
          <Input
            ref={inputRef}
            type={req.password ? 'password' : 'text'}
            value={value}
            placeholder={req.placeholder ?? req.requireText}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
      )}
      <div className="modal-footer">
        <Button variant="ghost" onClick={() => close(req.kind === 'prompt' ? null : false)}>
          {t('Cancel')}
        </Button>
        <Button variant={req.danger ? 'danger' : 'primary'} onClick={submit} disabled={!canConfirm} autoFocus={req.kind === 'confirm' && !req.requireText}>
          {req.confirmLabel ?? t('OK')}
        </Button>
      </div>
    </Modal>
  );
}
