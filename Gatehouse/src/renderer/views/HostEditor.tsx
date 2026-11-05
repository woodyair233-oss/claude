import { useMemo, useState } from 'react';
import { Bot, Eye, EyeOff, FlaskConical, Hand, KeyRound, Lock, Plug, Server, Settings2, ShieldCheck, Sparkles, Trash2, Zap } from 'lucide-react';
import type { AiMode, AuthMethod, Host, HostColor, HostDraft } from '@shared/types';
import { HOST_COLORS } from '@shared/types';
import { ALIAS_PATTERN, defaultAiPolicy, slugify } from '@shared/defaults';
import { assessCommand } from '@shared/command-policy';
import { decideCommand } from '@shared/policy';
import { api, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { HOST_COLOR_HEX } from '../lib/themes';
import { deleteHost } from '../lib/actions';
import { Sheet } from '../components/overlays';
import { Button, Callout, Field, Input, Segmented, Select, Switch, Tabs, TagInput, TextArea } from '../components/ui';
import { ListEditor, validatePattern } from '../components/ListEditor';
import { MODE_META, REASON_LABEL, RiskBadge } from '../components/domain';
import { KeyGenDialog, KeyImportDialog } from './KeyDialogs';

type Tab = 'general' | 'auth' | 'ai' | 'advanced';

function draftFrom(host: Host | undefined, defaultMode: AiMode): HostDraft {
  if (host) {
    const { id, alias, name, hostname, port, username, auth, keyId, savePassword, jumpHostId, group, tags, color, notes, keepAliveSec, startupCommand, favorite, legacyAlgorithms, ai } = host;
    return { id, alias, name, hostname, port, username, auth, keyId: keyId ?? null, savePassword, jumpHostId: jumpHostId ?? null, group, tags, color, notes, keepAliveSec, startupCommand, favorite, legacyAlgorithms, ai: structuredClone(ai) };
  }
  return {
    alias: '',
    name: '',
    hostname: '',
    port: 22,
    username: '',
    auth: 'key',
    keyId: null,
    savePassword: true,
    jumpHostId: null,
    group: '',
    tags: [],
    color: HOST_COLORS[Math.floor(Math.random() * 8)],
    notes: '',
    keepAliveSec: 30,
    startupCommand: '',
    favorite: false,
    legacyAlgorithms: false,
    ai: defaultAiPolicy(defaultMode),
  };
}

const MODE_ICONS: Record<AiMode, React.ReactNode> = {
  off: <EyeOff size={17} />,
  'read-only': <Eye size={17} />,
  ask: <Hand size={17} />,
  trusted: <Zap size={17} />,
};

function CommandTester({ draft }: { draft: HostDraft }) {
  const settings = useApp((s) => s.snap!.settings);
  const [cmd, setCmd] = useState('systemctl restart nginx');
  const result = useMemo(() => {
    if (!cmd.trim()) return null;
    const ai = settings.ai;
    const assessment = assessCommand(cmd, { extraReadOnly: ai.extraReadOnlyCommands, dangerPatterns: ai.dangerPatterns, blockPatterns: ai.blockPatterns, sensitivePaths: ai.sensitivePaths });
    const host = { ...(draft as unknown as Host), id: draft.id ?? 'draft', alias: draft.alias || 'host', keyId: draft.keyId ?? undefined, jumpHostId: draft.jumpHostId ?? undefined, createdAt: 0, updatedAt: 0 };
    const decision = decideCommand({ host, ai, security: settings.security, command: cmd, assessment, grantActive: false });
    return { assessment, decision };
  }, [cmd, draft, settings]);
  return (
    <div className="tester">
      <div className="field-label" style={{ marginBottom: 6 }}>
        <FlaskConical size={13} /> {t('Try a command')}
      </div>
      <Input mono value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="tail -n 50 /var/log/syslog" />
      {result && (
        <div className="tester-result">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <RiskBadge risk={result.assessment.risk} />
            {result.decision.verdict === 'allow' && <span className="badge green">{t('Runs automatically')}</span>}
            {result.decision.verdict === 'ask' && <span className="badge amber">{t('Asks you first')}{result.decision.requireTouchId ? ' · Touch ID' : ''}</span>}
            {result.decision.verdict === 'deny' && <span className="badge red">{t('Refused')}</span>}
            {result.assessment.sensitive && <span className="badge violet">{t('Sensitive')}</span>}
          </div>
          {result.assessment.reasons.length > 0 && (
            <ul className="reason-list">
              {result.assessment.reasons.slice(0, 5).map((r, i) => (
                <li key={i}>
                  {t(REASON_LABEL[r.code])}
                  {r.detail && <span className="mono faint"> · {r.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function HostEditor() {
  const { hostId, tab: initialTab } = useApp((s) => s.hostEditor);
  const close = useApp((s) => s.closeHostEditor);
  const snap = useApp((s) => s.snap!);
  const toast = useApp((s) => s.toast);
  const existing = hostId ? snap.hosts.find((h) => h.id === hostId) : undefined;
  const [draft, setDraft] = useState<HostDraft>(() => draftFrom(existing, snap.settings.ai.defaultMode));
  const [aliasTouched, setAliasTouched] = useState(!!existing);
  const [password, setPassword] = useState('');
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || 'general');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [keyDialog, setKeyDialog] = useState<'gen' | 'import' | null>(null);

  const set = <K extends keyof HostDraft>(k: K, v: HostDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setAi = <K extends keyof HostDraft['ai']>(k: K, v: HostDraft['ai'][K]) => setDraft((d) => ({ ...d, ai: { ...d.ai, [k]: v } }));

  const aliasError = draft.alias && !ALIAS_PATTERN.test(draft.alias) ? t('Lowercase letters, digits and dashes; max 40 characters.') : snap.hosts.some((h) => h.alias === draft.alias && h.id !== draft.id) ? t('Another host already uses this alias.') : '';
  const valid = !!draft.hostname.trim() && !!draft.alias && !aliasError && draft.port > 0 && draft.port < 65536;
  const hasSavedPassword = !!draft.id && snap.savedPasswords.includes(draft.id);
  const groups = [...new Set(snap.hosts.map((h) => h.group).filter(Boolean))];

  const updateName = (name: string) => {
    setDraft((d) => ({ ...d, name, alias: aliasTouched ? d.alias : slugify(name || d.hostname) }));
  };
  const updateHostname = (hostname: string) => {
    setDraft((d) => ({ ...d, hostname, alias: aliasTouched || d.name ? d.alias : slugify(hostname) }));
  };

  const save = async (andTest = false) => {
    if (!valid) {
      setTab('general');
      setError(t('Enter a hostname and a valid alias.'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const host = await api().hosts.save(draft, draft.auth === 'password' && draft.savePassword && password ? password : undefined);
      if (andTest) {
        setTesting(true);
        const r = await api().hosts.test(host.id);
        setTesting(false);
        toast(r.ok ? { kind: 'success', title: t('Connected to {name}', { name: host.name || host.alias }), message: r.osInfo } : { kind: 'error', title: t('Connection failed'), message: r.message });
        setDraft((d) => ({ ...d, id: host.id }));
        setAliasTouched(true);
        if (!r.ok) return;
      }
      toast({ kind: 'success', title: existing ? t('Host saved') : t('Host added') });
      close();
    } catch (err) {
      setError((err as Error).message);
      setTesting(false);
    } finally {
      setSaving(false);
    }
  };

  const keys = snap.keys;
  const jumpOptions = snap.hosts.filter((h) => h.id !== draft.id);

  return (
    <Sheet
      onClose={close}
      width={620}
      icon={<div className="sheet-avatar" style={{ background: HOST_COLOR_HEX[draft.color] }}><Server size={15} color="#fff" /></div>}
      title={existing ? draft.name || draft.alias || t('Edit host') : t('New host')}
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'general', label: t('General'), icon: <Server size={13} /> },
            { value: 'auth', label: t('Authentication'), icon: <KeyRound size={13} /> },
            { value: 'ai', label: t('AI Access'), icon: <Bot size={13} /> },
            { value: 'advanced', label: t('Advanced'), icon: <Settings2 size={13} /> },
          ]}
        />
      }
      footer={
        <>
          {existing && (
            <Button variant="danger-soft" icon={<Trash2 size={14} />} onClick={() => void deleteHost(existing).then(() => !useApp.getState().snap?.hosts.some((h) => h.id === existing.id) && close())}>
              {t('Delete')}
            </Button>
          )}
          {error && <span className="error-text ellipsis" title={error}>{error}</span>}
          <div className="spacer" />
          <Button variant="ghost" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button icon={<Plug size={14} />} loading={testing} disabled={saving} onClick={() => void save(true)}>
            {t('Save & Test')}
          </Button>
          <Button variant="primary" loading={saving && !testing} onClick={() => void save(false)}>
            {t('Save')}
          </Button>
        </>
      }
    >
      {tab === 'general' && (
        <>
          <Field label={t('Display name')}>
            <Input value={draft.name} onChange={(e) => updateName(e.target.value)} placeholder={t('e.g. Lab GPU server')} autoFocus={!existing} />
          </Field>
          <div className="field-row r-3-1">
            <Field label={t('Hostname or IP')}>
              <Input mono value={draft.hostname} onChange={(e) => updateHostname(e.target.value.trim())} placeholder="10.0.0.12" />
            </Field>
            <Field label={t('Port')}>
              <Input mono type="number" min={1} max={65535} value={draft.port} onChange={(e) => set('port', Number(e.target.value) || 22)} />
            </Field>
          </div>
          <Field label={t('Username')}>
            <Input mono value={draft.username} onChange={(e) => set('username', e.target.value.trim())} placeholder="ubuntu" />
          </Field>
          <Field
            label={
              <>
                <Sparkles size={12} color="var(--violet)" /> {t('Alias (the only name Claude sees)')}
              </>
            }
            error={aliasError}
            hint={t('Claude never sees the hostname, IP or username — only this alias.')}
          >
            <Input
              mono
              value={draft.alias}
              onChange={(e) => {
                setAliasTouched(true);
                set('alias', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40));
              }}
              placeholder="lab-gpu"
              invalid={!!aliasError}
            />
          </Field>
          <div className="field-row">
            <Field label={t('Group')}>
              <Input value={draft.group} onChange={(e) => set('group', e.target.value)} list="gh-groups" placeholder={t('e.g. Production')} />
              <datalist id="gh-groups">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>
            <Field label={t('Tags')}>
              <TagInput value={draft.tags} onChange={(v) => set('tags', v)} placeholder={t('Add tag…')} />
            </Field>
          </div>
          <Field label={t('Color')}>
            <div className="swatches">
              {HOST_COLORS.map((c) => (
                <button key={c} className={`swatch ${draft.color === c ? 'on' : ''}`} style={{ background: HOST_COLOR_HEX[c as HostColor] }} onClick={() => set('color', c)} aria-label={c} />
              ))}
            </div>
          </Field>
          <label className="row" style={{ marginBottom: 14 }}>
            <Switch on={draft.favorite} onChange={(v) => set('favorite', v)} />
            <span>{t('Favorite')}</span>
          </label>
          <Field label={t('Notes')} hint={t('Private — never shown to AI.')}>
            <TextArea value={draft.notes} onChange={(e) => set('notes', e.target.value)} rows={3} />
          </Field>
        </>
      )}

      {tab === 'auth' && (
        <>
          <Field label={t('Method')}>
            <Segmented<AuthMethod>
              block
              value={draft.auth}
              onChange={(v) => set('auth', v)}
              options={[
                { value: 'key', label: t('SSH key') },
                { value: 'password', label: t('Password') },
                { value: 'agent', label: t('SSH agent') },
                { value: 'interactive', label: t('Keyboard-interactive') },
              ]}
            />
          </Field>
          {draft.auth === 'key' && (
            <>
              <Field label={t('Key')}>
                {keys.length ? (
                  <Select
                    value={draft.keyId ?? ''}
                    onChange={(v) => set('keyId', v || null)}
                    options={[{ value: '', label: t('Choose a key…') }, ...keys.map((k) => ({ value: k.id, label: `${k.name} · ${k.type.toUpperCase()}${k.bits && k.type === 'rsa' ? ' ' + k.bits : ''}` }))]}
                  />
                ) : (
                  <div className="faint">{t('No keys yet. Generate one or import an existing key.')}</div>
                )}
              </Field>
              <div className="row" style={{ marginBottom: 14 }}>
                <Button size="sm" icon={<Sparkles size={13} />} onClick={() => setKeyDialog('gen')}>
                  {t('Generate key…')}
                </Button>
                <Button size="sm" icon={<KeyRound size={13} />} onClick={() => setKeyDialog('import')}>
                  {t('Import key…')}
                </Button>
              </div>
              <Callout icon={<Lock size={15} />}>{t('Private keys are stored in the encrypted vault. Install the public key on the server from the Keys page.')}</Callout>
            </>
          )}
          {draft.auth === 'password' && (
            <>
              <Field label={t('Password')} hint={hasSavedPassword ? t('A password is saved. Leave empty to keep it.') : undefined}>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={hasSavedPassword ? '••••••••' : ''} disabled={!draft.savePassword} />
              </Field>
              <label className="row" style={{ marginBottom: 14 }}>
                <Switch on={draft.savePassword} onChange={(v) => set('savePassword', v)} />
                <span>{t('Save password in the vault')}</span>
              </label>
              {!draft.savePassword && <Callout icon={<Lock size={15} />}>{t('Gatehouse will ask for the password each time it connects — including when Claude needs this host.')}</Callout>}
            </>
          )}
          {draft.auth === 'agent' && <Callout icon={<KeyRound size={15} />}>{t('Uses keys from your SSH agent (SSH_AUTH_SOCK, or the 1Password agent if present). Nothing is stored in Gatehouse.')}</Callout>}
          {draft.auth === 'interactive' && <Callout icon={<ShieldCheck size={15} />}>{t('Gatehouse shows the server prompts (password, one-time codes) in a dialog each time it connects.')}</Callout>}
        </>
      )}

      {tab === 'ai' && (
        <>
          <div className="mode-cards">
            {(['off', 'read-only', 'ask', 'trusted'] as AiMode[]).map((m) => (
              <button key={m} className={`mode-card ${draft.ai.mode === m ? 'on' : ''} mode-${m}`} onClick={() => setAi('mode', m)}>
                <div className="mc-icon">{MODE_ICONS[m]}</div>
                <div className="mc-title">
                  {t(MODE_META[m].label)}
                  {m === 'ask' && <span className="badge sm blue">{t('Recommended')}</span>}
                </div>
                <div className="mc-desc">{t(MODE_META[m].desc)}</div>
              </button>
            ))}
          </div>
          {draft.ai.mode !== 'off' && (
            <>
              <Field label={t('File writes by AI')}>
                <Segmented
                  block
                  value={draft.ai.mode === 'read-only' ? 'deny' : draft.ai.fileWrite}
                  onChange={(v) => setAi('fileWrite', v)}
                  options={[
                    { value: 'deny', label: t('Never') },
                    { value: 'ask', label: t('Ask me') },
                    { value: 'allow', label: t('Allow') },
                  ]}
                />
              </Field>
              <Field label={t('Description for Claude')} hint={t('Helps Claude pick the right host. Do not include secrets or addresses.')}>
                <TextArea value={draft.ai.description} onChange={(e) => setAi('description', e.target.value)} rows={2} placeholder={t('e.g. Ubuntu 24.04, runs the lab PACS gateway in Docker')} />
              </Field>
              <Field label={t('Always allow')} hint={t('Exact commands, or patterns with *, that run without asking (single commands only, never high-risk ones).')}>
                <ListEditor value={draft.ai.allowPatterns} onChange={(v) => setAi('allowPatterns', v)} placeholder="docker compose logs *" validate={validatePattern} />
              </Field>
              <Field label={t('Always refuse')} hint={t('Exact commands, * patterns or /regex/ that are refused on this host.')}>
                <ListEditor value={draft.ai.denyPatterns} onChange={(v) => setAi('denyPatterns', v)} placeholder="systemctl restart *" validate={validatePattern} />
              </Field>
              <label className="row" style={{ marginBottom: 16 }}>
                <Switch on={draft.ai.requireTouchId} onChange={(v) => setAi('requireTouchId', v)} />
                <span>{t('Require Touch ID for every approval on this host')}</span>
              </label>
              <CommandTester draft={draft} />
            </>
          )}
        </>
      )}

      {tab === 'advanced' && (
        <>
          <Field label={t('Jump host')} hint={t('Connect through another saved host (like ProxyJump).')}>
            <Select
              value={draft.jumpHostId ?? ''}
              onChange={(v) => set('jumpHostId', v || null)}
              options={[{ value: '', label: t('None — connect directly') }, ...jumpOptions.map((h) => ({ value: h.id, label: h.name || h.alias }))]}
            />
          </Field>
          <Field label={t('Keep-alive interval (seconds)')} hint={t('0 disables keep-alives.')}>
            <Input type="number" min={0} max={600} value={draft.keepAliveSec} onChange={(e) => set('keepAliveSec', Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <Field label={t('Startup command')} hint={t('Typed into new interactive terminals after login (not used for AI commands).')}>
            <Input mono value={draft.startupCommand} onChange={(e) => set('startupCommand', e.target.value)} placeholder="tmux attach || tmux" />
          </Field>
          <label className="row" style={{ marginBottom: 8 }}>
            <Switch on={draft.legacyAlgorithms} onChange={(v) => set('legacyAlgorithms', v)} />
            <span>{t('Allow legacy algorithms (SHA-1, CBC) for very old servers')}</span>
          </label>
          {draft.legacyAlgorithms && <Callout tone="amber" icon={<Lock size={15} />}>{t('Only enable this for servers that cannot be updated. Legacy algorithms are weaker.')}</Callout>}
        </>
      )}

      {keyDialog === 'gen' && <KeyGenDialog onClose={() => setKeyDialog(null)} onCreated={(k) => set('keyId', k.id)} />}
      {keyDialog === 'import' && <KeyImportDialog onClose={() => setKeyDialog(null)} onCreated={(k) => set('keyId', k.id)} />}
    </Sheet>
  );
}
