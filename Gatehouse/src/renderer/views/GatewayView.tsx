import { useEffect, useState } from 'react';
import { ArrowRight, Bot, CheckCircle2, CircleAlert, ClipboardCheck, Cpu, FileClock, Fingerprint, Link2, Plug, ScanEye, Server, ShieldCheck, ShieldHalf, Sparkles, TerminalSquare, Unplug, X, XCircle } from 'lucide-react';
import type { AiMode, SelfTestResult, SetupInfo } from '@shared/types';
import { api, attempt, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { countdown, relativeTime } from '../lib/format';
import { setHostMode } from '../lib/actions';
import { Toolbar } from '../components/Toolbar';
import { Button, Card, CodeBlock, IconButton, Segmented, Spinner, Switch, useTicker } from '../components/ui';
import { BarChart, HostDot, Logo, MODE_META } from '../components/domain';

function Stat({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: React.ReactNode }) {
  return (
    <div className="stat-tile">
      <div className="st-icon" style={{ color: tone, background: `color-mix(in srgb, ${tone} 13%, transparent)` }}>{icon}</div>
      <div>
        <div className="st-value tnum">{value}</div>
        <div className="st-label">{label}</div>
      </div>
    </div>
  );
}

function FlowDiagram() {
  return (
    <div className="flow">
      <div className="flow-node ai">
        <Bot size={18} />
        <div>
          <strong>Claude</strong>
          <span>{t('Claude Code / Desktop')}</span>
        </div>
      </div>
      <div className="flow-arrow"><span>MCP</span><ArrowRight size={14} /></div>
      <div className="flow-node gate">
        <Logo size={20} />
        <div>
          <strong>Gatehouse</strong>
          <span>{t('policy · approval · redaction · audit')}</span>
        </div>
      </div>
      <div className="flow-arrow"><span>SSH</span><ArrowRight size={14} /></div>
      <div className="flow-node srv">
        <Server size={18} />
        <div>
          <strong>{t('Your servers')}</strong>
          <span>{t('keys never leave the vault')}</span>
        </div>
      </div>
    </div>
  );
}

function SetupCard() {
  const toast = useApp((s) => s.toast);
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<SelfTestResult | null>(null);
  const refresh = () => void api().gateway.setupInfo().then(setInfo).catch(() => undefined);
  useEffect(refresh, []);

  const addCode = async () => {
    setBusy('code');
    const r = await attempt(() => api().gateway.installClaudeCode(), t('Could not configure Claude Code'));
    setBusy(null);
    if (r) toast(r.ok ? { kind: 'success', title: t('Added to Claude Code'), message: t('Run /mcp in Claude Code to see the gatehouse tools.') } : { kind: 'error', title: t('Could not configure Claude Code'), message: r.output });
  };
  const addDesktop = async () => {
    setBusy('desktop');
    const r = await attempt(() => api().gateway.installClaudeDesktop(), t('Could not configure Claude Desktop'));
    setBusy(null);
    if (r) toast(r.ok ? { kind: 'success', title: t('Added to Claude Desktop'), message: t('Quit and reopen Claude Desktop to load it.') } : { kind: 'error', title: t('Could not configure Claude Desktop'), message: r.message });
    refresh();
  };
  const runTest = async () => {
    setBusy('test');
    setTest(await api().gateway.selfTest().catch((err) => ({ ok: false, steps: [{ name: 'error', ok: false, detail: (err as Error).message }] })));
    setBusy(null);
  };

  return (
    <Card className="setup-card">
      <div className="card-header">
        <Plug size={16} color="var(--violet)" />
        <h3>{t('Connect Claude')}</h3>
        <span className="faint" style={{ fontSize: 12 }}>{t('Gatehouse runs a local MCP server. Claude starts it on demand.')}</span>
      </div>
      {!info ? (
        <div className="card-section"><Spinner /></div>
      ) : (
        <>
          {!info.bridgeExists && (
            <div className="card-section">
              <div className="callout red"><CircleAlert size={15} /><div>{t('The MCP bridge binary is missing at {path}. Reinstall Gatehouse.', { path: info.bridgePath })}</div></div>
            </div>
          )}
          <div className="card-section setup-step">
            <div className="setup-num">1</div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row">
                <strong>Claude Code</strong>
                {info.claudeCodeCli ? <span className="badge green sm">{t('found')}</span> : <span className="badge sm">{t('not found')}</span>}
                <div className="spacer" />
                <Button size="sm" variant="primary" loading={busy === 'code'} disabled={!info.claudeCodeCli} onClick={() => void addCode()}>{t('Add to Claude Code')}</Button>
              </div>
              <div className="faint" style={{ fontSize: 12, margin: '4px 0 8px' }}>{t('Or run this once in Terminal:')}</div>
              <CodeBlock code={info.claudeCodeCommand} />
            </div>
          </div>
          <div className="card-section setup-step">
            <div className="setup-num">2</div>
            <div className="grow">
              <div className="row">
                <strong>Claude Desktop</strong>
                {info.claudeDesktopConfigured && <span className="badge green sm"><CheckCircle2 size={10} />{t('configured')}</span>}
                <div className="spacer" />
                <Button size="sm" loading={busy === 'desktop'} onClick={() => void addDesktop()}>{info.claudeDesktopConfigured ? t('Re-add') : t('Add to Claude Desktop')}</Button>
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{t('Writes the gatehouse entry into {path} (a backup is kept).', { path: '~/Library/Application Support/Claude/claude_desktop_config.json' })}</div>
            </div>
          </div>
          <div className="card-section setup-step">
            <div className="setup-num">3</div>
            <div className="grow" style={{ minWidth: 0 }}>
              <strong>{t('Other MCP clients')}</strong>
              <div className="faint" style={{ fontSize: 12, margin: '4px 0 8px' }}>{t('Any client that supports stdio MCP servers (Cursor, VS Code, …):')}</div>
              <CodeBlock code={info.genericJson} />
            </div>
          </div>
          <div className="card-section">
            <div className="row">
              <Button icon={<ScanEye size={14} />} loading={busy === 'test'} onClick={() => void runTest()}>{t('Run self-test')}</Button>
              {test && (test.ok ? <span className="badge green"><CheckCircle2 size={11} />{t('Everything works')}</span> : <span className="badge red"><XCircle size={11} />{t('Something is wrong')}</span>)}
            </div>
            {test && (
              <ul className="selftest">
                {test.steps.map((s) => (
                  <li key={s.name}>
                    {s.ok ? <CheckCircle2 size={13} color="var(--green)" /> : <XCircle size={13} color="var(--red)" />}
                    <strong>{s.name === 'bridge' ? t('Bridge binary') : s.name === 'doctor' ? t('Socket & token') : s.name === 'mcp' ? t('MCP handshake') : s.name}</strong>
                    <span className="faint mono ellipsis">{s.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export function GatewayView() {
  useTicker(1000);
  const snap = useApp((s) => s.snap!);
  const go = useApp((s) => s.go);
  const g = snap.gateway;
  const enabled = snap.settings.ai.enabled;
  const clients = g.sessions.filter((s) => s.clientName !== 'Gatehouse self-test');
  const exposed = snap.hosts.filter((h) => h.ai.mode !== 'off').length;

  return (
    <>
      <Toolbar title={t('AI Gateway')} subtitle={t('How Claude reaches your servers')}>
        <Button icon={<FileClock size={14} />} onClick={() => go('audit')}>{t('Audit Log')}</Button>
      </Toolbar>
      <div className="content">
        <div className="page">
          <div className={`gw-hero ${enabled ? '' : 'paused'}`}>
            <div className="gw-hero-icon"><ShieldHalf size={30} /></div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="gw-hero-title">{enabled ? t('AI access is on') : t('AI access is paused')}</div>
              <div className="gw-hero-sub">
                {enabled
                  ? t('Claude can reach {n} host(s) — only through Gatehouse. Every request is checked against your policy, redacted, and logged.', { n: exposed })
                  : t('Every AI request is refused right now. Pending approvals were cancelled and running commands were stopped.')}
              </div>
              <div className="gw-hero-meta">
                <span className={`badge ${g.listening ? 'green' : 'red'}`}>{g.listening ? <CheckCircle2 size={11} /> : <XCircle size={11} />}{g.listening ? t('Local MCP socket ready') : t('MCP socket unavailable')}</span>
                {g.error && <span className="badge red">{g.error}</span>}
                {clients.map((c) => (
                  <span key={c.id} className="badge violet" title={t('Connected {when}', { when: relativeTime(c.connectedAt) })}>
                    <Link2 size={11} />
                    {c.clientName}
                    {c.clientVersion ? ` ${c.clientVersion}` : ''}
                    <span className="faint">· {c.requestCount}</span>
                  </span>
                ))}
                {!clients.length && <span className="badge outline"><Unplug size={11} />{t('No AI client connected')}</span>}
              </div>
            </div>
            <div className="col" style={{ alignItems: 'flex-end', gap: 8 }}>
              <Switch size="lg" tone="green" on={enabled} onChange={(v) => void api().gateway.setEnabled(v)} label={t('AI access')} />
              {clients.length > 0 && (
                <Button size="sm" variant="ghost" icon={<Unplug size={12} />} onClick={() => void api().gateway.disconnectClients()}>{t('Disconnect clients')}</Button>
              )}
            </div>
          </div>

          {g.pending.length > 0 && (
            <button className="pending-banner" onClick={() => go('approvals')}>
              <ClipboardCheck size={17} />
              <strong>{t('{n} request(s) waiting for your approval', { n: g.pending.length })}</strong>
              <span className="spacer" />
              <span>{t('Review')}</span>
              <ArrowRight size={14} />
            </button>
          )}

          <div className="gw-grid">
            <Card className="gw-stats">
              <div className="card-header">
                <h3>{t('Today')}</h3>
                <span className="spacer" />
                <button className="link-btn" onClick={() => go('activity')}>{t('View activity')} <ArrowRight size={12} /></button>
              </div>
              <div className="stat-row">
                <Stat label={t('Requests')} value={g.stats.total} tone="var(--violet)" icon={<Sparkles size={15} />} />
                <Stat label={t('Auto-approved')} value={g.stats.auto} tone="var(--green)" icon={<CheckCircle2 size={15} />} />
                <Stat label={t('You approved')} value={g.stats.approved} tone="var(--blue)" icon={<Fingerprint size={15} />} />
                <Stat label={t('Denied or blocked')} value={g.stats.denied + g.stats.blocked} tone="var(--red)" icon={<X size={15} />} />
              </div>
              <div className="card-section" style={{ paddingTop: 4 }}>
                <div className="faint" style={{ fontSize: 11.5, marginBottom: 6 }}>{t('Last 24 hours')}</div>
                <BarChart values={g.stats.hourly} height={56} />
                <div className="chart-axis"><span>{t('24 h ago')}</span><span>{t('12 h')}</span><span>{t('now')}</span></div>
              </div>
            </Card>
            <Card>
              <div className="card-header">
                <h3>{t('How it works')}</h3>
              </div>
              <div className="card-section">
                <FlowDiagram />
                <ul className="principles">
                  <li><ShieldCheck size={14} />{t('Claude only sees host aliases — never hostnames, IPs, usernames or keys.')}</li>
                  <li><TerminalSquare size={14} />{t('Commands are classified; anything risky waits for you.')}</li>
                  <li><ScanEye size={14} />{t('Output is sanitised and redacted before Claude reads it.')}</li>
                  <li><FileClock size={14} />{t('Every request lands in a tamper-evident audit log.')}</li>
                </ul>
              </div>
            </Card>
          </div>

          <div className="section-title">
            <Cpu size={15} /> {t('Host access')} <span className="muted">{t('{n} of {total} visible to AI', { n: exposed, total: snap.hosts.length })}</span>
          </div>
          {snap.hosts.length === 0 ? (
            <Card pad><span className="muted">{t('Add a host to give Claude something to work with.')}</span></Card>
          ) : (
            <Card style={{ overflow: 'hidden' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Host')}</th>
                    <th>{t('AI access')}</th>
                    <th>{t('File writes')}</th>
                    <th>{t('Session grant')}</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.hosts.map((h) => {
                    const grant = g.grants.find((x) => x.hostId === h.id);
                    return (
                      <tr key={h.id}>
                        <td>
                          <div className="row">
                            <HostDot color={h.color} />
                            <strong className="ellipsis">{h.name || h.alias}</strong>
                            <span className="mono faint">{h.alias}</span>
                          </div>
                        </td>
                        <td>
                          <Segmented<AiMode>
                            value={h.ai.mode}
                            onChange={(m) => void setHostMode(h, m)}
                            options={(['off', 'read-only', 'ask', 'trusted'] as AiMode[]).map((m) => ({ value: m, label: t(MODE_META[m].short), title: t(MODE_META[m].desc) }))}
                          />
                        </td>
                        <td className="muted">{h.ai.mode === 'off' ? '—' : h.ai.mode === 'read-only' ? t('Never') : h.ai.fileWrite === 'allow' ? t('Allow') : h.ai.fileWrite === 'ask' ? t('Ask me') : t('Never')}</td>
                        <td>
                          {grant ? (
                            <span className="row" style={{ gap: 6 }}>
                              <span className="badge amber tnum">{t('Auto-approving')} · {countdown(grant.expiresAt - Date.now())}</span>
                              <IconButton label={t('Revoke')} small onClick={() => void api().gateway.revokeGrant(h.id)}><X size={12} /></IconButton>
                            </span>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}

          <div className="section-title"><Plug size={15} /> {t('Setup')}</div>
          <SetupCard />
        </div>
      </div>
    </>
  );
}
