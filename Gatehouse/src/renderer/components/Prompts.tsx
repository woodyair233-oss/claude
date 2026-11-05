import { useEffect, useState } from 'react';
import { Bot, Fingerprint, KeyRound, Lock, ShieldAlert, ShieldQuestion, TriangleAlert } from 'lucide-react';
import type { PromptRequest } from '@shared/types';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { Modal, ModalHeader } from './overlays';
import { Button, Callout, Field, Input, Switch, useAutofocus } from './ui';
import { HostDot } from './domain';

function AiTag({ by }: { by: 'user' | 'ai' }) {
  if (by !== 'ai') return null;
  return (
    <span className="badge violet sm" style={{ marginLeft: 6 }}>
      <Bot size={10} />
      {t('requested by Claude')}
    </span>
  );
}

function HostKeyPrompt({ req }: { req: Extract<PromptRequest, { kind: 'host-key' }> }) {
  const [typed, setTyped] = useState('');
  const changed = req.status === 'changed';
  const respond = (accept: boolean) => void api().prompts.respond(req.id, { accept });
  return (
    <Modal onClose={() => respond(false)} dismissable={!changed}>
      <ModalHeader
        icon={changed ? <ShieldAlert size={20} /> : <ShieldQuestion size={20} />}
        tone={changed ? 'red' : undefined}
        title={changed ? t('Host key changed!') : t('Verify the server\'s identity')}
        subtitle={
          <span>
            <span className="mono">{req.hostAlias}</span> · <span className="mono">{req.host}:{req.port}</span>
            <AiTag by={req.initiatedBy} />
          </span>
        }
      />
      <div className="modal-body">
        {changed ? (
          <Callout tone="red" icon={<TriangleAlert size={15} />}>
            {t('The server presented a different key than the one Gatehouse trusts. This happens after a reinstall — or during a man-in-the-middle attack. Only continue if you know why it changed.')}
          </Callout>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>{t('This is the first connection to this server. Compare the fingerprint with the one shown on the server (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub).')}</p>
        )}
        {changed && req.previousFingerprint && (
          <Field label={t('Previously trusted')}>
            <div className="code fp-code strike">{req.previousFingerprint}</div>
          </Field>
        )}
        <Field label={changed ? t('Presented now') : `${t('Fingerprint')} · ${req.keyType.replace('ssh-', '').toUpperCase()}`}>
          <div className="code fp-code">{req.fingerprint}</div>
        </Field>
        {changed && (
          <Field label={t('Type {alias} to replace the trusted key', { alias: req.hostAlias })}>
            <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={req.hostAlias} />
          </Field>
        )}
      </div>
      <div className="modal-footer">
        <Button variant={changed ? 'primary' : 'ghost'} onClick={() => respond(false)} autoFocus={changed}>
          {changed ? t('Disconnect (recommended)') : t('Cancel')}
        </Button>
        <Button variant={changed ? 'danger' : 'primary'} disabled={changed && typed.trim() !== req.hostAlias} onClick={() => respond(true)} autoFocus={!changed}>
          {changed ? t('Trust new key') : t('Trust and connect')}
        </Button>
      </div>
    </Modal>
  );
}

function SecretPrompt({ req }: { req: Extract<PromptRequest, { kind: 'password' | 'passphrase' }> }) {
  const [value, setValue] = useState('');
  const [save, setSave] = useState(false);
  const ref = useAutofocus<HTMLInputElement>();
  const respond = (ok: boolean) => void api().prompts.respond(req.id, ok ? { value, save } : null);
  const host = useApp((s) => s.snap?.hosts.find((h) => req.kind === 'password' && h.alias === req.hostAlias));
  return (
    <Modal onClose={() => respond(false)}>
      <ModalHeader
        icon={req.kind === 'password' ? <Lock size={19} /> : <KeyRound size={19} />}
        title={req.kind === 'password' ? t('Password for {user}', { user: req.username || req.hostAlias }) : t('Passphrase for "{key}"', { key: req.keyName })}
        subtitle={
          <span className="row" style={{ gap: 6 }}>
            {req.kind === 'password' && host && <HostDot color={host.color} size={7} />}
            {req.kind === 'password' ? <span className="mono">{req.hostAlias}</span> : t('The private key is encrypted.')}
            <AiTag by={req.initiatedBy} />
          </span>
        }
      />
      <div className="modal-body">
        <Input ref={ref} type="password" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value && respond(true)} />
        <label className="row" style={{ marginTop: 12 }}>
          <Switch on={save} onChange={setSave} />
          <span>{t('Remember in the encrypted vault')}</span>
        </label>
      </div>
      <div className="modal-footer">
        <Button variant="ghost" onClick={() => respond(false)}>{t('Cancel')}</Button>
        <Button variant="primary" disabled={!value} onClick={() => respond(true)}>{t('Continue')}</Button>
      </div>
    </Modal>
  );
}

function InteractivePrompt({ req }: { req: Extract<PromptRequest, { kind: 'keyboard-interactive' }> }) {
  const [answers, setAnswers] = useState<string[]>(req.prompts.map(() => ''));
  const respond = (ok: boolean) => void api().prompts.respond(req.id, ok ? { answers } : null);
  return (
    <Modal onClose={() => respond(false)}>
      <ModalHeader icon={<Fingerprint size={19} />} title={req.name || t('Server sign-in')} subtitle={<span><span className="mono">{req.hostAlias}</span><AiTag by={req.initiatedBy} /></span>} />
      <div className="modal-body">
        {req.instructions && <p className="muted" style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{req.instructions}</p>}
        {req.prompts.map((p, i) => (
          <Field key={i} label={p.prompt.trim()}>
            <Input
              autoFocus={i === 0}
              type={p.echo ? 'text' : 'password'}
              value={answers[i]}
              onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
              onKeyDown={(e) => e.key === 'Enter' && respond(true)}
            />
          </Field>
        ))}
      </div>
      <div className="modal-footer">
        <Button variant="ghost" onClick={() => respond(false)}>{t('Cancel')}</Button>
        <Button variant="primary" onClick={() => respond(true)}>{t('Continue')}</Button>
      </div>
    </Modal>
  );
}

/** Shows the oldest interactive question from the main process. */
export function PromptHost() {
  const prompts = useApp((s) => s.snap?.prompts ?? []);
  const req = prompts[0];
  const [, force] = useState(0);
  useEffect(() => force((n) => n + 1), [req?.id]);
  if (!req) return null;
  if (req.kind === 'host-key') return <HostKeyPrompt key={req.id} req={req} />;
  if (req.kind === 'password' || req.kind === 'passphrase') return <SecretPrompt key={req.id} req={req} />;
  return <InteractivePrompt key={req.id} req={req} />;
}
