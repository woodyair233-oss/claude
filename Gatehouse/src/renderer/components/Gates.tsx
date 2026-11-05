import { useEffect, useState } from 'react';
import { Fingerprint, KeyRound, Lock, Server, ShieldCheck, Sparkles, X } from 'lucide-react';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { Logo } from './domain';
import { Button, Input, useAutofocus } from './ui';
import { Modal, ModalHeader } from './overlays';

/** Full-window lock screen. */
export function LockScreen() {
  const snap = useApp((s) => s.snap!);
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useAutofocus<HTMLInputElement>();
  const touch = snap.touchIdAvailable;

  const unlock = async (password?: string) => {
    setBusy(true);
    setError('');
    const r = await api().app.unlock(password).catch((err) => ({ ok: false, error: (err as Error).message }));
    setBusy(false);
    if (!r.ok) setError(r.error ?? t('Could not unlock'));
  };

  useEffect(() => {
    if (touch) void unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="lock-screen drag">
      <div className="lock-card no-drag">
        <Logo size={60} />
        <h2>{t('Gatehouse is locked')}</h2>
        <p className="muted">{t('The AI gateway keeps enforcing your policies. Approvals wait until you unlock.')}</p>
        {touch && (
          <Button variant="primary" size="lg" icon={<Fingerprint size={16} />} loading={busy && !pw} onClick={() => void unlock()}>
            {t('Unlock with Touch ID')}
          </Button>
        )}
        {snap.vault.passwordWrap && (
          <div className="row" style={{ width: '100%', marginTop: 10 }}>
            <Input ref={ref} type="password" placeholder={t('Master password')} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && void unlock(pw)} />
            <Button disabled={!pw} loading={busy && !!pw} onClick={() => void unlock(pw)}>{t('Unlock')}</Button>
          </div>
        )}
        {pending(snap) > 0 && <div className="badge amber" style={{ marginTop: 14 }}>{t('{n} approval(s) waiting', { n: pending(snap) })}</div>}
        {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
      </div>
    </div>
  );
}

function pending(snap: NonNullable<ReturnType<typeof useApp.getState>['snap']>) {
  return snap.gateway.pending.length;
}

/** First run without a Keychain (or a vault that needs its master password). */
export function VaultGate() {
  const vault = useApp((s) => s.snap!.vault);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const ref = useAutofocus<HTMLInputElement>();
  const creating = vault.state === 'uninitialized';

  // Locked with no password wrap: the Keychain copy of the key could not be
  // read and there is no password to fall back on. Offer Retry / Reset instead
  // of a password prompt that cannot succeed.
  if (vault.unrecoverable && !resetting) {
    const retry = async () => {
      setError('');
      setBusy(true);
      try {
        if (!(await api().vault.retryKeychain())) setError(t('The system keychain still could not be read. You can retry, or reset the vault.'));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="lock-screen drag">
        <div className="lock-card no-drag">
          <Logo size={60} />
          <h2>{t('Vault could not be unlocked')}</h2>
          <p className="muted">
            {t('Gatehouse could not read the vault key from the system keychain (for example after an app update, or if access was denied). Retry, or reset the vault — resetting creates a new, empty vault and loses saved passwords and keys (your hosts stay).')}
          </p>
          <Button variant="primary" size="lg" block loading={busy} style={{ marginTop: 12 }} onClick={() => void retry()}>
            {t('Retry keychain')}
          </Button>
          <Button variant="ghost" size="lg" block style={{ marginTop: 8 }} onClick={() => { setError(''); setResetting(true); }}>
            {t('Reset vault…')}
          </Button>
          {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
        </div>
      </div>
    );
  }

  const createLike = creating || resetting;
  const submit = async () => {
    setError('');
    if (createLike) {
      if (pw.length < 8) return setError(t('Use at least 8 characters.'));
      if (pw !== pw2) return setError(t('The passwords do not match'));
    }
    setBusy(true);
    try {
      if (resetting) await api().vault.reset(pw);
      else if (creating) await api().vault.create(pw);
      else if (!(await api().vault.unlock(pw))) setError(t('Incorrect password.'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen drag">
      <div className="lock-card no-drag">
        <Logo size={60} />
        <h2>{resetting ? t('Reset the vault') : creating ? t('Create a master password') : t('Unlock your vault')}</h2>
        <p className="muted">
          {resetting
            ? t('Choose a new master password. The old vault and any saved passwords and keys are discarded.')
            : creating
              ? t('The system keychain is not available, so Gatehouse protects your passwords and keys with a master password. It cannot be recovered if you forget it.')
              : t('Enter your master password to decrypt saved passwords and keys.')}
        </p>
        <Input ref={ref} type="password" placeholder={t('Master password')} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !createLike && void submit()} />
        {createLike && <Input type="password" placeholder={t('Repeat password')} value={pw2} style={{ marginTop: 8 }} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />}
        <Button variant="primary" size="lg" block loading={busy} style={{ marginTop: 12 }} icon={<Lock size={15} />} onClick={() => void submit()}>
          {resetting ? t('Reset vault') : creating ? t('Create vault') : t('Unlock')}
        </Button>
        {resetting && (
          <Button variant="ghost" size="lg" block style={{ marginTop: 8 }} onClick={() => { setError(''); setResetting(false); }}>
            {t('Cancel')}
          </Button>
        )}
        {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
      </div>
    </div>
  );
}

/** One-time welcome that explains the security model. */
export function Welcome() {
  const done = useApp((s) => s.snap!.settings.onboardingDone);
  const hosts = useApp((s) => s.snap!.hosts.length);
  const openEditor = useApp((s) => s.openHostEditor);
  const go = useApp((s) => s.go);
  const [visible, setVisible] = useState(!done && hosts === 0);
  if (!visible) return null;
  const finish = (then?: () => void) => {
    setVisible(false);
    void api().settings.update({ onboardingDone: true });
    then?.();
  };
  return (
    <Modal onClose={() => finish()} size="wide" className="welcome-modal">
      <div className="welcome-hero">
        <Logo size={56} />
        <h1>{t('Welcome to Gatehouse')}</h1>
        <p>{t('An SSH client that lets Claude work on your servers — without ever handing it the keys.')}</p>
        <button className="icon-btn welcome-close" onClick={() => finish()} aria-label={t('Close')}><X size={16} /></button>
      </div>
      <div className="welcome-steps">
        <div className="ws">
          <div className="ws-icon"><Server size={18} /></div>
          <strong>{t('1. Add your servers')}</strong>
          <span>{t('Credentials stay encrypted on this Mac. Import from ~/.ssh/config in one click.')}</span>
        </div>
        <div className="ws">
          <div className="ws-icon violet"><ShieldCheck size={18} /></div>
          <strong>{t('2. Choose what Claude may do')}</strong>
          <span>{t('Per host: Off, Read-only, Ask before changes, or Trusted. Risky commands always ask.')}</span>
        </div>
        <div className="ws">
          <div className="ws-icon green"><Sparkles size={18} /></div>
          <strong>{t('3. Connect Claude')}</strong>
          <span>{t('Add Gatehouse to Claude Code or Claude Desktop. Claude sees aliases, never addresses or keys.')}</span>
        </div>
      </div>
      <ModalHeader title="" />
      <div className="modal-footer">
        <Button variant="ghost" onClick={() => finish(() => go('gateway'))} icon={<KeyRound size={14} />}>{t('How it works')}</Button>
        <Button onClick={() => finish(() => useApp.getState().setMenuCommand('import-ssh-config'))}>{t('Import from SSH config')}</Button>
        <Button variant="primary" onClick={() => finish(() => openEditor())}>{t('Add a host')}</Button>
      </div>
    </Modal>
  );
}
