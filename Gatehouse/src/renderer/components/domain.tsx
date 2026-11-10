import type { ReactNode } from 'react';
import {
  Ban,
  BookOpen,
  Check,
  CircleAlert,
  CircleDashed,
  Clock,
  Eye,
  EyeOff,
  FileEdit,
  FileText,
  FolderOpen,
  Gauge,
  Hand,
  Info,
  ListTree,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
  Zap,
} from 'lucide-react';
import type { AiMode, AuditOutcome, Host, ReasonCode, RiskLevel } from '@shared/types';
import { t } from '../lib/i18n';
import { HOST_COLOR_HEX } from '../lib/themes';
import { Badge } from './ui';

// A risk ramp, least to most permissive: Off (gray) → Read-only (green) → Ask
// (blue) → Trusted (amber). Violet is reserved for Claude's own identity.
export const MODE_META: Record<AiMode, { label: string; short: string; tone: 'outline' | 'green' | 'blue' | 'amber'; icon: ReactNode; desc: string }> = {
  off: { label: 'Off', short: 'Off', tone: 'outline', icon: <EyeOff size={12} />, desc: 'Hidden from Claude. It cannot see or use this host.' },
  'read-only': { label: 'Read-only', short: 'Read-only', tone: 'green', icon: <Eye size={12} />, desc: 'Only recognised read-only commands run, automatically. Anything else is refused.' },
  ask: { label: 'Ask', short: 'Ask', tone: 'blue', icon: <Hand size={12} />, desc: 'Read-only commands run automatically; everything else waits for your approval.' },
  trusted: { label: 'Trusted', short: 'Trusted', tone: 'amber', icon: <Zap size={12} />, desc: 'Commands run automatically, except high-risk ones, which still need your approval.' },
};

export function ModeBadge({ mode, small }: { mode: AiMode; small?: boolean }) {
  const m = MODE_META[mode];
  return (
    <Badge tone={m.tone} small={small} icon={m.icon} title={t(m.desc)}>
      {t(m.short)}
    </Badge>
  );
}

export const RISK_META: Record<RiskLevel, { label: string; tone: 'green' | 'amber' | 'red'; icon: ReactNode }> = {
  read: { label: 'Read-only', tone: 'green', icon: <BookOpen size={11} /> },
  write: { label: 'Changes state', tone: 'amber', icon: <FileEdit size={11} /> },
  danger: { label: 'High risk', tone: 'red', icon: <ShieldAlert size={11} /> },
  block: { label: 'Blocked', tone: 'red', icon: <Ban size={11} /> },
};

export function RiskBadge({ risk, small }: { risk?: RiskLevel; small?: boolean }) {
  if (!risk) return null;
  const m = RISK_META[risk];
  return (
    <Badge tone={m.tone} small={small} icon={m.icon}>
      {t(m.label)}
    </Badge>
  );
}

export const OUTCOME_META: Record<AuditOutcome | 'pending' | 'running', { label: string; tone?: 'green' | 'amber' | 'red' | 'violet' | 'blue'; icon: ReactNode }> = {
  auto: { label: 'Auto-approved', tone: 'green', icon: <Check size={11} /> },
  approved: { label: 'Approved', tone: 'blue', icon: <ShieldCheck size={11} /> },
  denied: { label: 'Denied', tone: 'red', icon: <Hand size={11} /> },
  cancelled: { label: 'Cancelled', tone: 'amber', icon: <CircleDashed size={11} /> },
  blocked: { label: 'Blocked', tone: 'red', icon: <Ban size={11} /> },
  timeout: { label: 'Timed out', tone: 'amber', icon: <Timer size={11} /> },
  paused: { label: 'Paused', tone: 'amber', icon: <CircleDashed size={11} /> },
  error: { label: 'Error', tone: 'red', icon: <CircleAlert size={11} /> },
  'rate-limited': { label: 'Rate limited', tone: 'amber', icon: <Gauge size={11} /> },
  pending: { label: 'Waiting for you', tone: 'amber', icon: <Clock size={11} /> },
  running: { label: 'Running', tone: 'violet', icon: <Sparkles size={11} /> },
};

export function OutcomeBadge({ outcome, small }: { outcome: keyof typeof OUTCOME_META; small?: boolean }) {
  const m = OUTCOME_META[outcome];
  return (
    <Badge tone={m.tone} small={small} icon={m.icon}>
      {t(m.label)}
    </Badge>
  );
}

export function HostDot({ color, size = 8 }: { color: Host['color']; size?: number }) {
  return <span className="dot" style={{ width: size, height: size, background: HOST_COLOR_HEX[color] ?? HOST_COLOR_HEX.blue }} />;
}

export function HostChip({ alias, color }: { alias: string; color?: Host['color'] }) {
  return (
    <span className="host-chip">
      <HostDot color={color ?? 'gray'} size={7} />
      <span className="mono">{alias}</span>
    </span>
  );
}

export const TOOL_ICON: Record<string, ReactNode> = {
  run_command: <Terminal size={14} />,
  run_snippet: <Zap size={14} />,
  read_file: <FileText size={14} />,
  write_file: <FileEdit size={14} />,
  list_directory: <FolderOpen size={14} />,
  list_hosts: <ListTree size={14} />,
  list_snippets: <ListTree size={14} />,
  get_host_info: <Info size={14} />,
};

export const TOOL_LABEL: Record<string, string> = {
  run_command: 'Run command',
  run_snippet: 'Run snippet',
  read_file: 'Read file',
  write_file: 'Write file',
  list_directory: 'List directory',
  list_hosts: 'List hosts',
  list_snippets: 'List snippets',
  get_host_info: 'Host info',
};

export const REASON_LABEL: Record<ReasonCode, string> = {
  'parse-error': 'Could not be parsed reliably',
  substitution: 'Uses command substitution',
  'process-substitution': 'Uses process substitution',
  background: 'Starts a background job',
  subshell: 'Uses a subshell',
  'redirect-write': 'Writes to a file',
  heredoc: 'Uses a here-document',
  'pipe-to-shell': 'Pipes data into a shell',
  interpreter: 'Runs inline code or a script',
  sudo: 'Uses sudo (elevated privileges)',
  'unknown-program': 'Not a recognised read-only program',
  'modifying-args': 'Arguments modify state',
  'env-assignment': 'Changes environment or shell state',
  'variable-command': 'Command name comes from a variable',
  'network-tool': 'Makes network connections',
  delete: 'Deletes files',
  'recursive-delete': 'Deletes recursively or forcibly',
  'root-delete': 'Deletes a root or system directory',
  'device-overwrite': 'Writes directly to a disk device',
  'disk-destroy': 'Formats or wipes disks',
  power: 'Shuts down or reboots',
  firewall: 'Changes firewall or network settings',
  'ssh-lockout': 'Could lock you out of SSH',
  'user-account': 'Changes user accounts or passwords',
  'permissions-recursive': 'Changes permissions broadly',
  'kill-processes': 'Kills many processes',
  'package-remove': 'Removes packages',
  'container-destroy': 'Removes containers or cluster resources',
  'database-destroy': 'Drops or wipes database data',
  'git-destructive': 'Rewrites or discards git history',
  'infra-destroy': 'Destroys infrastructure',
  'history-tamper': 'Erases history or logs',
  'system-file-write': 'Modifies system files',
  'crontab-remove': 'Removes the crontab',
  'fork-bomb': 'Fork bomb',
  'download-exec': 'Downloads and executes code',
  'sensitive-path': 'Touches credential or secret files',
  'sensitive-command': 'May print secrets from the environment',
  'custom-danger': 'Matches your danger patterns',
  'custom-block': 'Matches your block patterns',
  'method-call': 'Calls a .NET or COM method',
  'registry-system': 'Changes system registry settings',
  'security-disable': 'Turns off security protections',
  'boot-config': 'Changes the boot configuration',
  empty: 'Empty command',
};

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="gh-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="0.55" stopColor="#3b5bdb" />
          <stop offset="1" stopColor="#0ea5a4" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#gh-logo-bg)" />
      <path d="M18 48V30c0-7.7 6.3-14 14-14s14 6.3 14 14v18" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
      <path d="M26 33l5 4-5 4" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M34 42h6" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}

export function BarChart({ values, height = 44, tone = 'var(--violet)' }: { values: number[]; height?: number; tone?: string }) {
  const max = Math.max(1, ...values);
  const w = 100 / values.length;
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label={t('Requests per hour, last 24 hours')}>
      {values.map((v, i) => {
        const h = v === 0 ? 1.5 : Math.max(3, (v / max) * (height - 4));
        return (
          <rect key={i} x={i * w + w * 0.18} y={height - h} width={w * 0.64} height={h} rx={1.2} fill={tone} opacity={v === 0 ? 0.18 : 0.35 + 0.65 * (v / max)}>
            <title>{`${v}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function CountdownRing({ remainingMs, totalMs, size = 34 }: { remainingMs: number; totalMs: number; size?: number }) {
  const frac = Math.max(0, Math.min(1, remainingMs / totalMs));
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const color = frac < 0.2 ? 'var(--red)' : frac < 0.5 ? 'var(--amber)' : 'var(--accent)';
  const secs = Math.max(0, Math.ceil(remainingMs / 1000));
  return (
    <svg width={size} height={size} className="countdown">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--active)" strokeWidth={3} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={10} fontWeight={650} fill="var(--text-2)" className="tnum">
        {secs > 99 ? `${Math.ceil(secs / 60)}m` : secs}
      </text>
    </svg>
  );
}

export function ServerIcon() {
  return <Server size={14} />;
}

/** Highlights [ip-1] style placeholders inside text. */
export function TokenText({ text }: { text: string }) {
  const parts = text.split(/(\[(?:ip|ipv6|mac|email|host)-\d+\]|\[(?:host|user):[a-z0-9-]+\]|\[redacted(?: private key)?\])/g);
  return (
    <>
      {parts.map((p, i) => (/^\[(ip|ipv6|mac|email|host|user|redacted)/.test(p) ? <span key={i} className="tok">{p}</span> : p))}
    </>
  );
}
