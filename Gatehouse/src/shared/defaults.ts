import type { AiMode, Host, HostAiPolicy, PortForward, Settings, Snippet } from './types';
import { DEFAULT_SENSITIVE_PATHS } from './command-policy';

export const APP_NAME = 'Gatehouse';
export const BUNDLE_ID = 'io.github.woodyair233.gatehouse';
export const MCP_SERVER_NAME = 'gatehouse';

export function defaultAiPolicy(mode: AiMode = 'ask'): HostAiPolicy {
  return {
    mode,
    fileWrite: 'ask',
    allowPatterns: [],
    denyPatterns: [],
    requireTouchId: false,
    description: '',
  };
}

export function defaultSettings(): Settings {
  return {
    language: 'system',
    theme: 'system',
    accent: 'blue',
    launchAtLogin: false,
    showInMenuBar: true,
    privacyMode: false,
    confirmOnQuit: true,
    terminal: {
      fontFamily: 'JetBrains Mono',
      fontSize: 13,
      lineHeight: 1.25,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 10000,
      theme: 'auto',
      copyOnSelect: false,
      optionIsMeta: true,
      bell: false,
    },
    security: {
      lockOnLaunch: false,
      autoLockMinutes: 0,
      touchIdForDangerous: true,
    },
    ai: {
      enabled: true,
      defaultMode: 'ask',
      approvalTimeoutSec: 120,
      autoApproveReadOnly: true,
      rateLimitPerMinute: 30,
      dailyQuota: 500,
      maxOutputKB: 48,
      commandTimeoutSec: 60,
      grantMinutes: 15,
      redaction: {
        ipAddresses: true,
        hostIdentity: true,
        secrets: true,
        macAddresses: true,
        emails: false,
        customRules: [],
      },
      extraReadOnlyCommands: [],
      dangerPatterns: [],
      blockPatterns: [],
      sensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
      auditRetentionDays: 90,
      storeOutputInAudit: true,
      notifyOnRequest: true,
    },
    onboardingDone: false,
  };
}

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/[\s_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, 40) || 'host';
}

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function newHost(partial: Partial<Host> & { id: string }, mode: AiMode = 'ask'): Host {
  const now = Date.now();
  return {
    alias: 'new-host',
    name: '',
    hostname: '',
    port: 22,
    username: '',
    auth: 'key',
    savePassword: false,
    group: '',
    tags: [],
    color: 'blue',
    notes: '',
    keepAliveSec: 30,
    startupCommand: '',
    favorite: false,
    legacyAlgorithms: false,
    ai: defaultAiPolicy(mode),
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function newForward(partial: Partial<PortForward> & { id: string; hostId: string }): PortForward {
  return {
    name: '',
    type: 'local',
    bindAddress: '127.0.0.1',
    bindPort: 8080,
    destHost: '127.0.0.1',
    destPort: 80,
    autoStart: false,
    ...partial,
  };
}

export function newSnippet(partial: Partial<Snippet> & { id: string }): Snippet {
  const now = Date.now();
  return {
    name: '',
    command: '',
    description: '',
    tags: [],
    aiAllowed: false,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function sampleSnippets(makeId: () => string): Snippet[] {
  const mk = (name: string, command: string, description: string, aiAllowed: boolean, tags: string[]) =>
    newSnippet({ id: makeId(), name, command, description, aiAllowed, tags });
  return [
    mk('System overview', 'uptime && free -h && df -h -x tmpfs -x devtmpfs', 'Load, memory and disk usage at a glance.', true, ['health']),
    mk('Top processes', 'ps aux --sort=-%cpu | head -15', 'The 15 busiest processes by CPU.', true, ['health']),
    mk('Listening ports', 'ss -tlnp', 'TCP sockets in LISTEN state with owning processes.', true, ['network']),
    mk('Failed services', 'systemctl --failed --no-pager', 'systemd units that are in a failed state.', true, ['systemd']),
    mk('Recent errors', 'journalctl -p err -n 50 --no-pager', 'The last 50 error-level journal entries.', true, ['logs']),
    mk('GPU status', 'nvidia-smi', 'NVIDIA GPU utilisation and memory.', false, ['gpu']),
  ];
}
