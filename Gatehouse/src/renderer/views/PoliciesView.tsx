import { useEffect, useMemo, useState } from 'react';
import { Ban, BookOpen, EyeOff, FlaskConical, Plus, RotateCcw, ScanEye, ShieldAlert, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { AiMode, AiSettings, RedactionRule } from '@shared/types';
import { DEFAULT_SENSITIVE_PATHS, assessCommand } from '@shared/command-policy';
import { decideCommand } from '@shared/policy';
import { newHost } from '@shared/defaults';
import { api, attempt, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { Toolbar } from '../components/Toolbar';
import { Button, Card, Input, Select, SettingRow, Switch, TextArea } from '../components/ui';
import { ListEditor, validateRegex } from '../components/ListEditor';
import { MODE_META, REASON_LABEL, RiskBadge, TokenText } from '../components/domain';

function NumberSetting({ value, onCommit, min, max, suffix, width = 90 }: { value: number; onCommit: (v: number) => void; min: number; max: number; suffix?: string; width?: number }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Math.min(max, Math.max(min, Number(v) || min));
    setV(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <span className="row" style={{ gap: 6 }}>
      <Input type="number" style={{ width }} value={v} min={min} max={max} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      {suffix && <span className="faint">{suffix}</span>}
    </span>
  );
}

function RedactionTester() {
  const [input, setInput] = useState('Connected to db01.internal.example (10.20.0.14) as alice\nexport AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nDB_PASSWORD=s3cr3t-Passw0rd\ninet6 fe80::1c2b:3cff:fe4d:5e6f  ether 02:42:ac:11:00:02');
  const [out, setOut] = useState<{ text: string; count: number; kinds: Record<string, number> } | null>(null);
  const settings = useApp((s) => s.snap!.settings.ai.redaction);
  useEffect(() => {
    const id = setTimeout(() => void api().gateway.previewRedaction(input).then(setOut), 200);
    return () => clearTimeout(id);
  }, [input, settings]);
  return (
    <div className="redaction-tester">
      <div>
        <div className="ac-label">{t('Sample output')}</div>
        <TextArea mono rows={6} value={input} onChange={(e) => setInput(e.target.value)} />
      </div>
      <div>
        <div className="ac-label">
          {t('What Claude would see')}
          {out && <span className="faint">· {t('{n} redaction(s)', { n: out.count })}</span>}
        </div>
        <pre className="code selectable" style={{ minHeight: 122, margin: 0 }}>{out ? <TokenText text={out.text} /> : ''}</pre>
      </div>
    </div>
  );
}

function CommandTester() {
  const snap = useApp((s) => s.snap!);
  const [cmd, setCmd] = useState('sudo systemctl restart nginx && journalctl -u nginx -n 20');
  const [hostId, setHostId] = useState(snap.hosts.find((h) => h.ai.mode !== 'off')?.id ?? '');
  const result = useMemo(() => {
    if (!cmd.trim()) return null;
    const ai = snap.settings.ai;
    const assessment = assessCommand(cmd, { extraReadOnly: ai.extraReadOnlyCommands, dangerPatterns: ai.dangerPatterns, blockPatterns: ai.blockPatterns, sensitivePaths: ai.sensitivePaths });
    const host = snap.hosts.find((h) => h.id === hostId) ?? newHost({ id: 'x', alias: 'example' }, 'ask');
    return { assessment, decision: decideCommand({ host, ai, security: snap.settings.security, command: cmd, assessment, grantActive: false }), host };
  }, [cmd, hostId, snap]);
  return (
    <div className="card-section">
      <div className="row" style={{ marginBottom: 8 }}>
        <Input mono value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="ls -la /var/log" />
        <div style={{ width: 200, flexShrink: 0 }}>
          <Select value={hostId} onChange={setHostId} options={[{ value: '', label: t('Example host (Ask)') }, ...snap.hosts.map((h) => ({ value: h.id, label: `${h.alias} · ${t(MODE_META[h.ai.mode].short)}` }))]} />
        </div>
      </div>
      {result && (
        <div className="tester-result">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <RiskBadge risk={result.assessment.risk} />
            {result.decision.verdict === 'allow' && <span className="badge green">{t('Runs automatically')}</span>}
            {result.decision.verdict === 'ask' && <span className="badge amber">{t('Asks you first')}{result.decision.requireTouchId ? ' · Touch ID' : ''}</span>}
            {result.decision.verdict === 'deny' && <span className="badge red">{t('Refused')}</span>}
            {result.assessment.sensitive && <span className="badge violet">{t('Sensitive')}</span>}
            {result.assessment.programs.length > 0 && <span className="faint mono" style={{ fontSize: 11.5 }}>{result.assessment.programs.join(' · ')}</span>}
          </div>
          {result.decision.verdict === 'deny' && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>{result.decision.message}</div>}
          {result.assessment.reasons.length > 0 && (
            <ul className="reason-list">
              {result.assessment.reasons.map((r, i) => (
                <li key={i}>{t(REASON_LABEL[r.code])}{r.detail && <span className="mono faint"> · {r.detail}</span>}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function CustomRules({ rules, onChange }: { rules: RedactionRule[]; onChange: (r: RedactionRule[]) => void }) {
  const add = () => onChange([...rules, { id: crypto.randomUUID(), name: '', pattern: '', flags: 'i', replacement: '[redacted]', enabled: true }]);
  const patch = (id: string, p: Partial<RedactionRule>) => onChange(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  return (
    <div className="custom-rules">
      {rules.map((r) => {
        const invalid = !!r.pattern && validateRegex(r.pattern) !== null;
        return (
          <div key={r.id} className="cr-row">
            <Switch on={r.enabled} onChange={(v) => patch(r.id, { enabled: v })} />
            <Input value={r.name} placeholder={t('Name')} onChange={(e) => patch(r.id, { name: e.target.value })} style={{ width: 140 }} />
            <Input mono value={r.pattern} placeholder={t('Regular expression')} invalid={invalid} onChange={(e) => patch(r.id, { pattern: e.target.value })} />
            <Input mono value={r.replacement} placeholder="[redacted]" onChange={(e) => patch(r.id, { replacement: e.target.value })} style={{ width: 150 }} />
            <button className="icon-btn danger" onClick={() => onChange(rules.filter((x) => x.id !== r.id))} aria-label={t('Remove')}><Trash2 size={13} /></button>
          </div>
        );
      })}
      <Button size="sm" icon={<Plus size={13} />} onClick={add}>{t('Add rule')}</Button>
      <div className="hint faint" style={{ fontSize: 11.5, marginTop: 6 }}>{t('Example: MRN\\d{6,10} → [MRN] hides medical record numbers. Use $1 to keep a captured group.')}</div>
    </div>
  );
}

export function PoliciesView() {
  const ai = useApp((s) => s.snap!.settings.ai);
  const security = useApp((s) => s.snap!.settings.security);
  const [rules, setRules] = useState(ai.redaction.customRules);
  useEffect(() => setRules(ai.redaction.customRules), [ai.redaction.customRules]);

  const update = (patch: Partial<AiSettings> | Record<string, unknown>) => void attempt(() => api().settings.update({ ai: patch }), t('Could not save settings'));
  const updateRedaction = (patch: Partial<AiSettings['redaction']>) => update({ redaction: patch });

  useEffect(() => {
    const id = setTimeout(() => {
      const valid = rules.filter((r) => !r.pattern || validateRegex(r.pattern) === null);
      if (JSON.stringify(valid) !== JSON.stringify(ai.redaction.customRules)) updateRedaction({ customRules: valid });
    }, 500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  return (
    <>
      <Toolbar title={t('Policies')} subtitle={t('Global rules for every AI request')} />
      <div className="content">
        <div className="page page-narrow">
          <div className="section-title"><SlidersHorizontal size={15} /> {t('Defaults & limits')}</div>
          <Card>
            <SettingRow title={t('Access level for new hosts')} desc={t('Hosts you add or import start with this AI access level.')}>
              <Select<AiMode>
                value={ai.defaultMode}
                onChange={(v) => update({ defaultMode: v })}
                options={(['off', 'read-only', 'ask', 'trusted'] as AiMode[]).map((m) => ({ value: m, label: t(MODE_META[m].label) }))}
              />
            </SettingRow>
            <SettingRow title={t('Auto-approve read-only commands in Ask mode')} desc={t('Turn off to approve every single command yourself.')}>
              <Switch on={ai.autoApproveReadOnly} onChange={(v) => update({ autoApproveReadOnly: v })} />
            </SettingRow>
            <SettingRow title={t('Approval timeout')} desc={t('Requests you do not answer are denied after this long.')}>
              <NumberSetting value={ai.approvalTimeoutSec} min={15} max={900} suffix={t('seconds')} onCommit={(v) => update({ approvalTimeoutSec: v })} />
            </SettingRow>
            <SettingRow title={t('Session grant length')} desc={t('"Allow for N min" auto-approves non-high-risk actions on that host for this long.')}>
              <NumberSetting value={ai.grantMinutes} min={1} max={240} suffix={t('minutes')} onCommit={(v) => update({ grantMinutes: v })} />
            </SettingRow>
            <SettingRow title={t('Command timeout')} desc={t('AI commands are signalled and stopped after this long (Claude can ask for up to 1 hour).')}>
              <NumberSetting value={ai.commandTimeoutSec} min={5} max={3600} suffix={t('seconds')} onCommit={(v) => update({ commandTimeoutSec: v })} />
            </SettingRow>
            <SettingRow title={t('Output returned to Claude')} desc={t('Longer output keeps its beginning and end; the middle is cut.')}>
              <NumberSetting value={ai.maxOutputKB} min={4} max={512} suffix="KB" onCommit={(v) => update({ maxOutputKB: v })} />
            </SettingRow>
            <SettingRow title={t('Rate limit')} desc={t('Maximum AI requests per minute across all clients.')}>
              <NumberSetting value={ai.rateLimitPerMinute} min={1} max={600} suffix={t('per minute')} onCommit={(v) => update({ rateLimitPerMinute: v })} />
            </SettingRow>
            <SettingRow title={t('Daily limit')} desc={t('A circuit breaker: after this many AI actions in a day everything is refused.')}>
              <NumberSetting value={ai.dailyQuota} min={1} max={100000} width={100} onCommit={(v) => update({ dailyQuota: v })} />
            </SettingRow>
            <SettingRow title={t('Touch ID for high-risk approvals')} desc={t('High-risk commands need Touch ID (or typing the host alias) to approve.')}>
              <Switch on={security.touchIdForDangerous} onChange={(v) => void api().settings.update({ security: { touchIdForDangerous: v } })} />
            </SettingRow>
          </Card>

          <div className="section-title"><FlaskConical size={15} /> {t('Try a command')}</div>
          <Card>
            <CommandTester />
          </Card>

          <div className="section-title"><ShieldAlert size={15} /> {t('Command rules')}</div>
          <Card>
            <div className="card-section">
              <div className="rule-head"><BookOpen size={14} color="var(--green)" /><strong>{t('Extra read-only commands')}</strong></div>
              <p className="faint rule-desc">{t('Program names (or "program subcommand") you consider read-only, in addition to the built-in list. Use with care: e.g. adding curl lets Claude make network requests without asking.')}</p>
              <ListEditor value={ai.extraReadOnlyCommands} onChange={(v) => update({ extraReadOnlyCommands: v })} placeholder="mytool status" emptyText={t('None — only built-in read-only commands auto-run.')} />
            </div>
            <div className="card-section">
              <div className="rule-head"><ShieldAlert size={14} color="var(--amber)" /><strong>{t('Extra high-risk patterns')}</strong></div>
              <p className="faint rule-desc">{t('Regular expressions (case-insensitive) that always require approval, even on trusted hosts.')}</p>
              <ListEditor value={ai.dangerPatterns} onChange={(v) => update({ dangerPatterns: v })} placeholder="\\bprod(uction)?\\b" validate={validateRegex} emptyText={t('None')} />
            </div>
            <div className="card-section">
              <div className="rule-head"><Ban size={14} color="var(--red)" /><strong>{t('Always-blocked patterns')}</strong></div>
              <p className="faint rule-desc">{t('Regular expressions that are refused outright. Built in: recursive deletion of / or system folders, writes to raw disks, fork bombs.')}</p>
              <ListEditor value={ai.blockPatterns} onChange={(v) => update({ blockPatterns: v })} placeholder="DROP\\s+DATABASE" validate={validateRegex} emptyText={t('None (built-in blocks still apply)')} />
            </div>
            <div className="card-section">
              <div className="rule-head">
                <EyeOff size={14} color="var(--violet)" />
                <strong>{t('Sensitive paths')}</strong>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => update({ sensitivePaths: DEFAULT_SENSITIVE_PATHS })}>{t('Reset to defaults')}</Button>
              </div>
              <p className="faint rule-desc">{t('Glob patterns for credential files. Reading them always needs approval; prefix with ! to exclude (e.g. !*.pub). Add folders that hold patient or other confidential data.')}</p>
              <ListEditor value={ai.sensitivePaths} onChange={(v) => update({ sensitivePaths: v })} placeholder="/data/patients/**" max={500} />
            </div>
          </Card>

          <div className="section-title"><ScanEye size={15} /> {t('Redaction')}</div>
          <Card>
            <SettingRow title={t('IP addresses')} desc={t('IPv4 and IPv6 become [ip-1], [ipv6-1]… Claude can reuse them; Gatehouse substitutes the real value.')}>
              <Switch on={ai.redaction.ipAddresses} onChange={(v) => updateRedaction({ ipAddresses: v })} />
            </SettingRow>
            <SettingRow title={t('Saved hostnames and usernames')} desc={t('Become [host:alias] and [user:alias].')}>
              <Switch on={ai.redaction.hostIdentity} onChange={(v) => updateRedaction({ hostIdentity: v })} />
            </SettingRow>
            <SettingRow title={t('Secrets')} desc={t('Private keys, API tokens (AWS, GitHub, Slack, OpenAI, Anthropic…), passwords in key=value pairs, credentials in URLs and other high-entropy strings.')}>
              <Switch on={ai.redaction.secrets} onChange={(v) => updateRedaction({ secrets: v })} />
            </SettingRow>
            <SettingRow title={t('MAC addresses')}>
              <Switch on={ai.redaction.macAddresses} onChange={(v) => updateRedaction({ macAddresses: v })} />
            </SettingRow>
            <SettingRow title={t('Email addresses')}>
              <Switch on={ai.redaction.emails} onChange={(v) => updateRedaction({ emails: v })} />
            </SettingRow>
            <div className="card-section">
              <strong>{t('Custom rules')}</strong>
              <div style={{ marginTop: 8 }}>
                <CustomRules rules={rules} onChange={setRules} />
              </div>
            </div>
            <div className="card-section">
              <strong>{t('Live preview')}</strong>
              <div style={{ marginTop: 8 }}>
                <RedactionTester />
              </div>
            </div>
            <div className="card-section">
              <div className="callout amber">
                <ShieldAlert size={15} />
                <div>{t('Redaction protects privacy, not secrets from a determined model: with shell access, data can be transformed (e.g. base64) so no pattern matches. Keep truly sensitive hosts on Read-only or Off.')}</div>
              </div>
            </div>
          </Card>

          <div className="section-title">{t('Audit & notifications')}</div>
          <Card>
            <SettingRow title={t('Keep audit history for')}>
              <NumberSetting value={ai.auditRetentionDays} min={1} max={3650} suffix={t('days')} onCommit={(v) => update({ auditRetentionDays: v })} />
            </SettingRow>
            <SettingRow title={t('Store output previews in the audit log')} desc={t('The redacted output Claude saw (first 4 KB). Turn off to log metadata only.')}>
              <Switch on={ai.storeOutputInAudit} onChange={(v) => update({ storeOutputInAudit: v })} />
            </SettingRow>
            <SettingRow title={t('Notify me about approval requests')} desc={t('Shows a macOS notification when Gatehouse is in the background.')}>
              <Switch on={ai.notifyOnRequest} onChange={(v) => update({ notifyOnRequest: v })} />
            </SettingRow>
          </Card>
        </div>
      </div>
    </>
  );
}
