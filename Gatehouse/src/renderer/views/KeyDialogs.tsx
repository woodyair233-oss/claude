import { useState } from 'react';
import { FileKey, KeyRound, Sparkles } from 'lucide-react';
import type { SshKeyInfo } from '@shared/types';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { Modal, ModalHeader } from '../components/overlays';
import { Button, Field, Input, Segmented, Switch, TextArea, useAutofocus } from '../components/ui';

export function KeyGenDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (k: SshKeyInfo) => void }) {
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState('');
  const [type, setType] = useState<'ed25519' | 'rsa' | 'ecdsa'>('ed25519');
  const [comment, setComment] = useState('gatehouse');
  const [passphrase, setPassphrase] = useState('');
  const [savePass, setSavePass] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useAutofocus<HTMLInputElement>();

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const key = await api().keys.generate({
        name: name.trim() || `${type.toUpperCase()} key`,
        type,
        bits: type === 'rsa' ? 4096 : type === 'ecdsa' ? 256 : undefined,
        comment,
        passphrase: passphrase || undefined,
        savePassphrase: savePass,
      });
      toast({ kind: 'success', title: t('Key generated'), message: key.fingerprint });
      onCreated?.(key);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Sparkles size={19} />} title={t('Generate SSH key')} subtitle={t('The private key never leaves the encrypted vault.')} onClose={onClose} />
      <div className="modal-body">
        <Field label={t('Name')}>
          <Input ref={ref} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Lab servers')} />
        </Field>
        <Field label={t('Type')} hint={type === 'ed25519' ? t('Recommended: modern, fast and small.') : type === 'rsa' ? t('RSA 4096 for older servers that lack Ed25519.') : t('ECDSA P-256.')}>
          <Segmented
            block
            value={type}
            onChange={setType}
            options={[
              { value: 'ed25519', label: 'Ed25519' },
              { value: 'rsa', label: 'RSA 4096' },
              { value: 'ecdsa', label: 'ECDSA' },
            ]}
          />
        </Field>
        <Field label={t('Comment')}>
          <Input mono value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <Field label={t('Passphrase (optional)')} hint={t('Adds a second lock on the key itself.')}>
          <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </Field>
        {passphrase && (
          <label className="row" style={{ marginBottom: 6 }}>
            <Switch on={savePass} onChange={setSavePass} />
            <span>{t('Remember the passphrase in the vault')}</span>
          </label>
        )}
        {error && <div className="field"><div className="error">{error}</div></div>}
      </div>
      <div className="modal-footer">
        <Button variant="ghost" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button variant="primary" loading={busy} onClick={submit} icon={<KeyRound size={14} />}>
          {t('Generate')}
        </Button>
      </div>
    </Modal>
  );
}

export function KeyImportDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (k: SshKeyInfo) => void }) {
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState('');
  const [pem, setPem] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [needsPass, setNeedsPass] = useState(false);
  const [savePass, setSavePass] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async () => {
    try {
      const f = await api().keys.pickFile();
      if (!f) return;
      setPem(f.privateKey);
      if (!name) setName(f.name);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const key = await api().keys.importText({ name: name.trim() || t('Imported key'), privateKey: pem, passphrase: passphrase || undefined, savePassphrase: savePass });
      toast({ kind: 'success', title: t('Key imported'), message: key.fingerprint });
      onCreated?.(key);
      onClose();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('NEEDS_PASSPHRASE')) {
        setNeedsPass(true);
        setError(t('This key is protected by a passphrase. Enter it to import.'));
      } else if (msg.startsWith('BAD_PASSPHRASE')) {
        setNeedsPass(true);
        setError(t('The passphrase is incorrect.'));
      } else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<FileKey size={19} />} title={t('Import private key')} subtitle={t('OpenSSH, PEM (RSA/EC) and PuTTY keys are supported.')} onClose={onClose} />
      <div className="modal-body">
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="id_ed25519" />
        </Field>
        <Field label={t('Private key')} extra={<Button size="sm" onClick={pick}>{t('Choose File…')}</Button>}>
          <TextArea mono value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style={{ minHeight: 130 }} />
        </Field>
        {needsPass && (
          <>
            <Field label={t('Passphrase')}>
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
            </Field>
            <label className="row" style={{ marginBottom: 6 }}>
              <Switch on={savePass} onChange={setSavePass} />
              <span>{t('Remember the passphrase in the vault')}</span>
            </label>
          </>
        )}
        {error && <div className="field"><div className="error">{error}</div></div>}
      </div>
      <div className="modal-footer">
        <Button variant="ghost" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button variant="primary" loading={busy} disabled={!pem.trim()} onClick={submit}>
          {t('Import')}
        </Button>
      </div>
    </Modal>
  );
}
