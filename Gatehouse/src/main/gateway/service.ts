// Runtime state of the AI gateway: sessions, activity, stats, admission
// control (kill switch, rate limit, daily quota) and output presentation.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  ActivityItem,
  AuditEntry,
  AuditOutcome,
  GatewayStats,
  GatewayStatus,
  Host,
  McpSessionInfo,
} from '../../shared/types';
import type { ClassifierOptions } from '../../shared/command-policy';
import { TokenMap, redact, sanitizeOutput, truncateMiddle, type Identity } from '../../shared/redaction';
import type { Store } from '../store';
import type { Vault } from '../vault';
import type { ConnectionManager } from '../ssh/connection';
import type { SftpManager } from '../ssh/sftp';
import { ApprovalCenter, type TouchIdProvider } from './approvals';
import { AuditLog } from './audit';

const MAX_ACTIVITY = 400;
const DAY_MS = 86_400_000;

export interface GatewayDeps {
  store: Store;
  vault: Vault;
  pool: ConnectionManager;
  sftp: SftpManager;
  touchId: TouchIdProvider;
  appVersion: string;
  auditDir: string;
  bridgePath: () => string;
  bridgeExists: () => boolean;
}

interface SessionRecord extends McpSessionInfo {
  close: () => void;
}

const KNOWN_CLIENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude Desktop',
  'claude-desktop': 'Claude Desktop',
  claude: 'Claude',
  cursor: 'Cursor',
  'cursor-vscode': 'Cursor',
  vscode: 'VS Code',
  'visual-studio-code': 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  'gatehouse-self-test': 'Gatehouse self-test',
};

export function prettyClientName(name: string): string {
  const key = name.trim().toLowerCase().replace(/\s+/g, '-');
  if (KNOWN_CLIENTS[key]) return KNOWN_CLIENTS[key];
  if (/^[a-z0-9-]+$/.test(name)) return name.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return name.slice(0, 60);
}

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export class GatewayService extends EventEmitter {
  readonly tokens = new TokenMap();
  readonly approvals: ApprovalCenter;
  readonly audit: AuditLog;
  private sessions = new Map<string, SessionRecord>();
  private activity: ActivityItem[] = [];
  private running = new Map<string, AbortController>();
  private callTimes: number[] = [];
  private recentEntries: AuditEntry[] = [];
  listening = false;
  socketPath = '';
  error?: string;

  constructor(readonly deps: GatewayDeps) {
    super();
    this.approvals = new ApprovalCenter(deps.touchId);
    this.audit = new AuditLog(deps.auditDir);
    this.approvals.on('change', () => this.emit('change'));
  }

  async init() {
    try {
      this.audit.prune(this.settings.ai.auditRetentionDays);
      this.recentEntries = (await this.audit.recent(Date.now() - DAY_MS)).reverse();
      this.activity = this.recentEntries
        .slice(-60)
        .reverse()
        .map((e) => ({ ...e, status: 'done' as const }));
    } catch (err) {
      console.error('[gatehouse] could not load audit history', err);
    }
  }

  get settings() {
    return this.deps.store.settings;
  }

  // Sessions ------------------------------------------------------------------

  addSession(info: McpSessionInfo, close: () => void) {
    this.sessions.set(info.id, { ...info, close });
    this.emit('change');
  }

  updateSession(id: string, patch: Partial<McpSessionInfo>) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (patch.clientName) patch = { ...patch, clientName: prettyClientName(patch.clientName) };
    let changed = false;
    for (const [k, v] of Object.entries(patch) as [keyof McpSessionInfo, never][]) {
      if (v !== undefined && s[k] !== v) {
        (s as unknown as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  removeSession(id: string) {
    if (this.sessions.delete(id)) this.emit('change');
  }

  session(id: string): McpSessionInfo | undefined {
    return this.sessions.get(id);
  }

  disconnectClients() {
    for (const s of [...this.sessions.values()]) s.close();
  }

  // Status --------------------------------------------------------------------

  stats(): GatewayStats {
    const now = Date.now();
    const since = now - DAY_MS;
    this.recentEntries = this.recentEntries.filter((e) => e.ts >= since);
    const today = dayKey(now);
    const stats: GatewayStats = { total: 0, auto: 0, approved: 0, denied: 0, blocked: 0, errors: 0, hourly: new Array(24).fill(0) };
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    for (const e of this.recentEntries) {
      const bucket = 23 - Math.floor((hourStart.getTime() - new Date(e.ts).setMinutes(0, 0, 0)) / 3_600_000);
      if (bucket >= 0 && bucket < 24) stats.hourly[bucket]++;
      if (dayKey(e.ts) !== today) continue;
      stats.total++;
      if (e.outcome === 'auto') stats.auto++;
      else if (e.outcome === 'approved') stats.approved++;
      else if (e.outcome === 'denied' || e.outcome === 'timeout') stats.denied++;
      else if (e.outcome === 'blocked' || e.outcome === 'rate-limited' || e.outcome === 'paused') stats.blocked++;
      else if (e.outcome === 'error') stats.errors++;
    }
    return stats;
  }

  status(): GatewayStatus {
    return {
      listening: this.listening,
      socketPath: this.socketPath,
      bridgePath: this.deps.bridgePath(),
      bridgeExists: this.deps.bridgeExists(),
      error: this.error,
      sessions: [...this.sessions.values()].map(({ close: _c, ...s }) => s),
      pending: this.approvals.list(),
      grants: this.approvals.listGrants(),
      stats: this.stats(),
    };
  }

  recentActivity(): ActivityItem[] {
    return this.activity;
  }

  clearActivity() {
    this.activity = this.activity.filter((a) => a.status !== 'done');
    this.emit('activity-reset');
  }

  // Kill switch -----------------------------------------------------------------

  setEnabled(enabled: boolean) {
    this.deps.store.updateSettings({ ai: { enabled } });
    if (!enabled) {
      this.approvals.cancelAll('AI access was paused by the user in Gatehouse.');
      this.approvals.revokeAll();
      for (const c of this.running.values()) c.abort();
    }
    this.emit('change');
  }

  // Admission -------------------------------------------------------------------

  admit(): { ok: true } | { ok: false; outcome: AuditOutcome; message: string } {
    const ai = this.settings.ai;
    if (!ai.enabled) {
      return { ok: false, outcome: 'paused', message: 'AI access is paused in Gatehouse. Ask the user to resume it if needed.' };
    }
    const now = Date.now();
    this.callTimes = this.callTimes.filter((t) => t > now - 60_000);
    if (this.callTimes.length >= ai.rateLimitPerMinute) {
      return { ok: false, outcome: 'rate-limited', message: `Rate limit reached (${ai.rateLimitPerMinute} calls per minute). Wait a moment and batch work into fewer commands.` };
    }
    const today = dayKey(now);
    const usedToday = this.recentEntries.filter((e) => dayKey(e.ts) === today && e.outcome !== 'rate-limited').length;
    if (usedToday >= ai.dailyQuota) {
      return { ok: false, outcome: 'rate-limited', message: `The daily limit of ${ai.dailyQuota} AI actions has been reached. Ask the user to raise it in Gatehouse settings.` };
    }
    this.callTimes.push(now);
    return { ok: true };
  }

  // Hosts -------------------------------------------------------------------------

  visibleHosts(): Host[] {
    return this.deps.store.data.hosts.filter((h) => h.ai.mode !== 'off');
  }

  resolveHost(alias: string): Host | undefined {
    const host = this.deps.store.findHostByAlias(alias.replace(/^\[host:|\]$/g, ''));
    return host && host.ai.mode !== 'off' ? host : undefined;
  }

  /** Saved host identities for redaction; the host a command ran on wins ties (shared usernames/hostnames). */
  identities(preferHostId?: string): Identity[] {
    const hosts = [...this.deps.store.data.hosts];
    if (preferHostId) hosts.sort((a, b) => (a.id === preferHostId ? -1 : b.id === preferHostId ? 1 : 0));
    return hosts.map((h) => ({
      alias: h.alias,
      hostname: h.hostname,
      username: h.username,
      visible: h.ai.mode !== 'off',
    }));
  }

  classifierOptions(): ClassifierOptions {
    const ai = this.settings.ai;
    return {
      extraReadOnly: ai.extraReadOnlyCommands,
      dangerPatterns: ai.dangerPatterns,
      blockPatterns: ai.blockPatterns,
      sensitivePaths: ai.sensitivePaths,
    };
  }

  /** Sanitise → redact → truncate. Everything returned to the AI goes through here. */
  present(text: string, maxBytes?: number, preferHostId?: string): { text: string; redactions: number; truncated: boolean } {
    const clean = sanitizeOutput(text);
    const r = redact(clean, { settings: this.settings.ai.redaction, identities: this.identities(preferHostId), tokens: this.tokens });
    const t = truncateMiddle(r.text, maxBytes ?? this.settings.ai.maxOutputKB * 1024);
    return { text: t.text, redactions: r.count, truncated: t.truncated };
  }

  // Activity ----------------------------------------------------------------------

  begin(fields: Omit<AuditEntry, 'id' | 'ts' | 'outcome'>, status: ActivityItem['status'] = 'running'): ActivityItem {
    const item: ActivityItem = { ...fields, id: randomUUID(), ts: Date.now(), outcome: 'auto', status };
    this.activity.unshift(item);
    if (this.activity.length > MAX_ACTIVITY) this.activity.length = MAX_ACTIVITY;
    const s = this.sessions.get(fields.sessionId);
    if (s) s.requestCount++;
    this.emit('activity', item);
    return item;
  }

  update(id: string, patch: Partial<ActivityItem>) {
    const item = this.activity.find((a) => a.id === id);
    if (!item) return;
    Object.assign(item, patch);
    this.emit('activity', item);
  }

  controller(id: string, signal?: AbortSignal): AbortController {
    const c = new AbortController();
    if (signal) {
      if (signal.aborted) c.abort();
      else signal.addEventListener('abort', () => c.abort(), { once: true });
    }
    this.running.set(id, c);
    return c;
  }

  /** Finalises an activity item and appends it to the audit log. */
  end(id: string, patch: Partial<AuditEntry> & { outcome: AuditOutcome }): AuditEntry | undefined {
    this.running.delete(id);
    const item = this.activity.find((a) => a.id === id);
    if (!item) return undefined;
    Object.assign(item, patch, { status: 'done' });
    const { status: _s, ...entry } = item;
    if (!this.settings.ai.storeOutputInAudit) delete entry.outputPreview;
    void this.audit.append(entry);
    this.recentEntries.push(entry);
    this.emit('activity', item);
    this.emit('change');
    return entry;
  }

  /** Records a request refused before it started (paused, rate limited, unknown host…). */
  refuse(fields: Omit<AuditEntry, 'id' | 'ts' | 'outcome'>, outcome: AuditOutcome, error: string) {
    const item = this.begin(fields, 'done');
    this.end(item.id, { outcome, error, decidedBy: 'policy' });
  }
}
