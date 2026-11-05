// Shared data model for main, preload and renderer.

export type AiMode = 'off' | 'read-only' | 'ask' | 'trusted';
export type FileWriteMode = 'deny' | 'ask' | 'allow';
export type AuthMethod = 'key' | 'password' | 'agent' | 'interactive';
export type HostColor =
  | 'gray'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink';

export const HOST_COLORS: HostColor[] = [
  'blue',
  'indigo',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'gray',
];

export interface HostAiPolicy {
  mode: AiMode;
  fileWrite: FileWriteMode;
  /** Exact commands or `*` globs auto-approved on this host (single simple commands only). */
  allowPatterns: string[];
  /** Exact commands, `*` globs or /regex/ always refused on this host. */
  denyPatterns: string[];
  /** Require Touch ID for every approval on this host. */
  requireTouchId: boolean;
  /** Free text shown to the AI in list_hosts (purpose, OS, caveats). Never include secrets. */
  description: string;
}

export interface Host {
  id: string;
  /** Unique slug. This is the only identifier the AI ever sees. */
  alias: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyId?: string;
  savePassword: boolean;
  jumpHostId?: string;
  group: string;
  tags: string[];
  color: HostColor;
  notes: string;
  keepAliveSec: number;
  startupCommand: string;
  favorite: boolean;
  /** Allow SHA-1 / CBC algorithms for very old servers. */
  legacyAlgorithms: boolean;
  ai: HostAiPolicy;
  createdAt: number;
  updatedAt: number;
  lastConnectedAt?: number;
  osInfo?: string;
}

export type KeyType = 'ed25519' | 'rsa' | 'ecdsa' | 'unknown';

export interface SshKeyInfo {
  id: string;
  name: string;
  type: KeyType;
  bits?: number;
  publicKey: string;
  fingerprint: string;
  comment: string;
  encrypted: boolean;
  savePassphrase: boolean;
  source: 'generated' | 'imported';
  createdAt: number;
}

export interface KnownHostEntry {
  id: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  publicKey: string;
  addedAt: number;
  lastSeenAt: number;
}

export type ForwardType = 'local' | 'remote' | 'dynamic';

export interface PortForward {
  id: string;
  name: string;
  hostId: string;
  type: ForwardType;
  bindAddress: string;
  bindPort: number;
  destHost: string;
  destPort: number;
  autoStart: boolean;
}

export interface ForwardStatus {
  id: string;
  state: 'stopped' | 'starting' | 'running' | 'error';
  error?: string;
  connections: number;
  bytesIn: number;
  bytesOut: number;
  startedAt?: number;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  description: string;
  tags: string[];
  /** When true the AI may run this exact command via run_snippet with auto-approval. */
  aiAllowed: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AccentColor = 'blue' | 'indigo' | 'violet' | 'pink' | 'orange' | 'green' | 'teal' | 'graphite';
export type LanguagePref = 'system' | 'en' | 'zh-Hans';
export type ThemePref = 'system' | 'light' | 'dark';

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  scrollback: number;
  theme: string;
  copyOnSelect: boolean;
  optionIsMeta: boolean;
  bell: boolean;
}

export interface SecuritySettings {
  lockOnLaunch: boolean;
  autoLockMinutes: number;
  touchIdForDangerous: boolean;
}

export interface RedactionRule {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  enabled: boolean;
}

export interface RedactionSettings {
  ipAddresses: boolean;
  hostIdentity: boolean;
  secrets: boolean;
  macAddresses: boolean;
  emails: boolean;
  customRules: RedactionRule[];
}

export interface AiSettings {
  enabled: boolean;
  defaultMode: AiMode;
  approvalTimeoutSec: number;
  autoApproveReadOnly: boolean;
  rateLimitPerMinute: number;
  /** Circuit breaker: maximum AI tool calls per day before everything is refused. */
  dailyQuota: number;
  maxOutputKB: number;
  commandTimeoutSec: number;
  grantMinutes: number;
  redaction: RedactionSettings;
  extraReadOnlyCommands: string[];
  dangerPatterns: string[];
  blockPatterns: string[];
  sensitivePaths: string[];
  auditRetentionDays: number;
  storeOutputInAudit: boolean;
  notifyOnRequest: boolean;
}

export interface Settings {
  language: LanguagePref;
  theme: ThemePref;
  accent: AccentColor;
  launchAtLogin: boolean;
  showInMenuBar: boolean;
  privacyMode: boolean;
  confirmOnQuit: boolean;
  terminal: TerminalSettings;
  security: SecuritySettings;
  ai: AiSettings;
  onboardingDone: boolean;
}

// ---------------------------------------------------------------------------
// Command assessment / gateway

export type RiskLevel = 'read' | 'write' | 'danger' | 'block';

export type ReasonCode =
  | 'parse-error'
  | 'substitution'
  | 'process-substitution'
  | 'background'
  | 'subshell'
  | 'redirect-write'
  | 'heredoc'
  | 'pipe-to-shell'
  | 'interpreter'
  | 'sudo'
  | 'unknown-program'
  | 'modifying-args'
  | 'env-assignment'
  | 'variable-command'
  | 'network-tool'
  | 'delete'
  | 'recursive-delete'
  | 'root-delete'
  | 'device-overwrite'
  | 'disk-destroy'
  | 'power'
  | 'firewall'
  | 'ssh-lockout'
  | 'user-account'
  | 'permissions-recursive'
  | 'kill-processes'
  | 'package-remove'
  | 'container-destroy'
  | 'database-destroy'
  | 'git-destructive'
  | 'infra-destroy'
  | 'history-tamper'
  | 'system-file-write'
  | 'crontab-remove'
  | 'fork-bomb'
  | 'download-exec'
  | 'sensitive-path'
  | 'sensitive-command'
  | 'custom-danger'
  | 'custom-block'
  | 'empty';

export interface Reason {
  code: ReasonCode;
  detail?: string;
}

export interface CommandAssessment {
  risk: RiskLevel;
  /** Reads secrets/credentials: always needs a human, even when read-only. */
  sensitive: boolean;
  reasons: Reason[];
  programs: string[];
  /** A single simple command with no operators: eligible for allow-pattern matching. */
  simple: boolean;
}

export type ApprovalKind = 'command' | 'write-file' | 'read-file' | 'list-directory' | 'snippet';

export type PolicyCause =
  | 'mode-ask'
  | 'danger'
  | 'sensitive'
  | 'file-write'
  | 'read-only-sensitive'
  | 'system-path';

export interface ClientInfo {
  sessionId: string;
  name: string;
  version?: string;
  parentName?: string;
}

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  createdAt: number;
  expiresAt: number;
  hostId: string;
  hostAlias: string;
  hostName: string;
  hostColor: HostColor;
  client: ClientInfo;
  /** What will actually run (placeholders resolved). */
  command?: string;
  /** What the AI sent, if it differs (contained placeholders). */
  aiCommand?: string;
  path?: string;
  contentPreview?: string;
  contentBytes?: number;
  appendMode?: boolean;
  reason?: string;
  assessment?: CommandAssessment;
  cause: PolicyCause;
  requireTouchId: boolean;
  /** Offer "always allow this exact command" (not for dangerous commands). */
  allowRemember: boolean;
}

export type ApprovalDecision =
  | { action: 'allow'; scope: 'once' | 'always' | 'grant'; editedCommand?: string }
  | { action: 'deny'; message?: string };

export type AuditOutcome =
  | 'auto'
  | 'approved'
  | 'denied'
  | 'blocked'
  | 'timeout'
  | 'paused'
  | 'error'
  | 'rate-limited';

export type DecidedBy = 'policy' | 'user' | 'allowlist' | 'grant' | 'snippet';

export interface AuditEntry {
  id: string;
  ts: number;
  sessionId: string;
  client: string;
  tool: string;
  hostAlias?: string;
  hostId?: string;
  command?: string;
  path?: string;
  reason?: string;
  risk?: RiskLevel;
  outcome: AuditOutcome;
  decidedBy?: DecidedBy;
  userMessage?: string;
  edited?: boolean;
  exitCode?: number | null;
  durationMs?: number;
  bytesOut?: number;
  redactions?: number;
  truncated?: boolean;
  error?: string;
  outputPreview?: string;
}

export type ActivityStatus = 'pending-approval' | 'running' | 'done';

export interface ActivityItem extends AuditEntry {
  status: ActivityStatus;
}

export interface McpSessionInfo {
  id: string;
  clientName: string;
  clientVersion?: string;
  parentName?: string;
  connectedAt: number;
  requestCount: number;
}

export interface SessionGrant {
  hostId: string;
  hostAlias: string;
  expiresAt: number;
}

export interface GatewayStats {
  total: number;
  auto: number;
  approved: number;
  denied: number;
  blocked: number;
  errors: number;
  /** 24 hourly buckets, oldest first, ending with the current hour. */
  hourly: number[];
}

export interface GatewayStatus {
  listening: boolean;
  socketPath: string;
  bridgePath: string;
  bridgeExists: boolean;
  error?: string;
  sessions: McpSessionInfo[];
  pending: ApprovalRequest[];
  grants: SessionGrant[];
  stats: GatewayStats;
}

// ---------------------------------------------------------------------------
// Terminals, SFTP, prompts

export type TerminalState = 'connecting' | 'connected' | 'closed' | 'error';

export interface TerminalSessionInfo {
  id: string;
  hostId: string;
  title: string;
  state: TerminalState;
  error?: string;
  startedAt: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  mtime: number;
  mode: number;
  permissions: string;
  owner?: string;
  group?: string;
  linkTarget?: string;
}

export interface TransferInfo {
  id: string;
  hostId: string;
  direction: 'upload' | 'download';
  name: string;
  localPath: string;
  remotePath: string;
  totalBytes: number;
  transferredBytes: number;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export type PromptRequest =
  | {
      id: string;
      kind: 'host-key';
      hostAlias: string;
      host: string;
      port: number;
      keyType: string;
      fingerprint: string;
      status: 'unknown' | 'changed';
      previousFingerprint?: string;
      initiatedBy: 'user' | 'ai';
    }
  | { id: string; kind: 'password'; hostAlias: string; username: string; host: string; initiatedBy: 'user' | 'ai' }
  | { id: string; kind: 'passphrase'; keyName: string; initiatedBy: 'user' | 'ai' }
  | {
      id: string;
      kind: 'keyboard-interactive';
      hostAlias: string;
      name: string;
      instructions: string;
      prompts: { prompt: string; echo: boolean }[];
      initiatedBy: 'user' | 'ai';
    };

export type PromptResponse =
  | { accept: boolean }
  | { value: string; save: boolean }
  | { answers: string[] }
  | null;

export interface ImportCandidate {
  alias: string;
  hostname: string;
  port: number;
  username: string;
  identityFile?: string;
  proxyJump?: string;
  exists: boolean;
}

export interface AppSnapshot {
  appVersion: string;
  platform: string;
  hosts: Host[];
  keys: SshKeyInfo[];
  knownHosts: KnownHostEntry[];
  forwards: PortForward[];
  forwardStatus: Record<string, ForwardStatus>;
  snippets: Snippet[];
  settings: Settings;
  gateway: GatewayStatus;
  terminals: TerminalSessionInfo[];
  transfers: TransferInfo[];
  prompts: PromptRequest[];
  savedPasswords: string[];
  connectedHostIds: string[];
  uiLocked: boolean;
  darkMode: boolean;
  touchIdAvailable: boolean;
  vault: VaultStatusInfo;
}

export interface VaultStatusInfo {
  state: 'uninitialized' | 'locked' | 'unlocked';
  backend: 'keychain' | 'os' | 'basic' | 'unavailable';
  keychainWrap: boolean;
  passwordWrap: boolean;
}

export type MenuCommand =
  | 'new-host'
  | 'command-palette'
  | 'settings'
  | 'open-approvals'
  | 'open-gateway'
  | 'new-terminal'
  | 'close-tab'
  | 'find'
  | 'import-ssh-config'
  | 'lock';

export interface Toast {
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
}

export interface ContextMenuItem {
  id?: string;
  label?: string;
  type?: 'normal' | 'separator';
  enabled?: boolean;
  danger?: boolean;
  accelerator?: string;
}

export interface AuditQueryInput {
  limit?: number;
  offset?: number;
  host?: string;
  outcome?: string;
  tool?: string;
  text?: string;
}

export interface AuditVerifyInfo {
  ok: boolean;
  entries: number;
  files: number;
  brokenAt?: { file: string; line: number; reason: string };
}

export interface RedactionPreview {
  text: string;
  count: number;
  kinds: Record<string, number>;
}

export interface CommandPreview {
  assessment: CommandAssessment;
  verdict: 'allow' | 'ask' | 'deny';
  detail: string;
}

export interface KeyGenInput {
  name: string;
  type: 'ed25519' | 'rsa' | 'ecdsa';
  bits?: number;
  comment: string;
  passphrase?: string;
  savePassphrase: boolean;
}

export interface KeyImportInput {
  name: string;
  privateKey: string;
  passphrase?: string;
  savePassphrase: boolean;
}

export type HostDraft = Omit<Host, 'id' | 'createdAt' | 'updatedAt' | 'lastConnectedAt' | 'osInfo' | 'keyId' | 'jumpHostId'> & {
  id?: string;
  keyId?: string | null;
  jumpHostId?: string | null;
};

export type ForwardDraft = Omit<PortForward, 'id'> & { id?: string };
export type SnippetDraft = Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

export type SnapshotPatch = Partial<AppSnapshot>;

export interface SetupInfo {
  bridgePath: string;
  bridgeExists: boolean;
  claudeCodeCommand: string;
  claudeCodeCli?: string;
  claudeDesktopConfigPath: string;
  claudeDesktopConfigured: boolean;
  genericJson: string;
}

export interface SelfTestResult {
  ok: boolean;
  steps: { name: string; ok: boolean; detail?: string }[];
}

export interface HostTestResult {
  ok: boolean;
  message: string;
  osInfo?: string;
  latencyMs?: number;
}
