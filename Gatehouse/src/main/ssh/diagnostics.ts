// Connection diagnostics: every attempt to open an SSH connection is traced step
// by step (look-up, network connection, SSH greeting, encryption, server
// identity, login) and, when it fails, given a cause the user can act on.
//
// What is recorded never includes secrets: passwords, passphrases, answers and
// key material are not passed in, and ssh2's protocol log does not print them.
// Host names, addresses and user names are recorded — the log is the user's own,
// stored privately on this Mac, and is never shown to Claude. What Claude gets
// is only the English cause summary (CONN_CAUSE_TITLE), whose placeholders are
// limited to a port number and login-method names.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import type { ConnAttempt, ConnCause, ConnParams, ConnStatus, ConnStep, ConnStepCode, Host } from '../../shared/types';
import { CONN_DROP_TEXT, CONN_TUNNEL_TEXT, connCauseMessage } from '../../shared/conn-text';
import { DebouncedWriter, readJsonSync } from '../fsutil';

export type ConnStage = 'prepare' | 'jump' | 'dns' | 'tcp' | 'ident' | 'kex' | 'hostkey' | 'auth' | 'ready';

const MAX_ATTEMPTS = 200;
const MAX_PER_HOST = 30;
/** Only the newest failed attempts keep their (larger) protocol log. */
const MAX_WITH_LOG = 25;
const MAX_LOG_LINES = 400;
const MAX_LOG_LINE = 300;
const MAX_STEPS = 80;
const MAX_PARAM = 200;

export const DNS_TIMEOUT_MS = 10_000;
export const TCP_TIMEOUT_MS = 20_000;
/** Real SSH servers greet at once; old ones doing slow reverse look-ups can take a while. */
export const IDENT_TIMEOUT_MS = 60_000;

/** A failed connection, with the diagnosis. `message` is the English summary (what Claude sees). */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly connCause: ConnCause,
    readonly connParams: ConnParams | undefined,
    readonly attemptId: string,
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

/** A failure found before any network activity (no key, locked vault, cancelled prompt…). */
export class ConnPrepError extends Error {
  constructor(
    message: string,
    readonly connCause: ConnCause,
  ) {
    super(message);
    this.name = 'ConnPrepError';
  }
}

export function isConnectError(err: unknown): err is ConnectError {
  return err instanceof ConnectError;
}

/** English text for why a live connection ended (a value of CONN_DROP_TEXT, translated in the UI). */
export function dropReason(err: unknown): string {
  const e = err as { message?: string; code?: string | number; level?: string } | undefined;
  if (!e) return CONN_DROP_TEXT.closed;
  const msg = e.message ?? '';
  const code = typeof e.code === 'string' ? e.code : '';
  if (/keepalive/i.test(msg)) return CONN_DROP_TEXT.keepalive;
  if (code === 'ECONNRESET' || code === 'EPIPE') return CONN_DROP_TEXT.reset;
  if (code === 'ETIMEDOUT' || /timed out/i.test(msg)) return CONN_DROP_TEXT.timeout;
  if (['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN'].includes(code)) return CONN_DROP_TEXT.unreachable;
  return CONN_DROP_TEXT.other;
}

/** Readable name for an SSH key type, e.g. "ssh-ed25519" → "ED25519". */
export function keyTypeLabel(keyType: string): string {
  if (keyType === 'ssh-ed25519') return 'ED25519';
  if (keyType === 'ssh-rsa' || keyType.startsWith('rsa-')) return 'RSA';
  const ec = /^ecdsa-sha2-nistp(\d+)$/.exec(keyType);
  if (ec) return `ECDSA P-${ec[1]}`;
  if (keyType === 'ssh-dss') return 'DSA';
  return keyType;
}

// Control characters (become spaces), and bidi overrides/isolates and other
// invisible formatting characters (removed).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;
const INVISIBLE_CHARS = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Makes text a server sent safe to display: no control or bidi characters, single line, capped. */
export function cleanServerText(text: string, max = 160): string {
  const flat = String(text).replace(INVISIBLE_CHARS, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Login-method names from the server: only protocol-name characters, a handful at most. */
export function cleanMethods(list: readonly unknown[] | null | undefined): string[] {
  if (!list) return [];
  return list
    .map((m) => String(m).trim())
    .filter((m) => /^[a-z0-9@._+-]{1,64}$/i.test(m) && m !== 'none')
    .slice(0, 10);
}

function cleanParams(params?: ConnParams): ConnParams | undefined {
  if (!params) return undefined;
  const out: ConnParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'number' ? v : cleanServerText(String(v), MAX_PARAM);
  }
  return out;
}

/** The most telling error code (happy-eyeballs failures carry one per address). */
export function errorCode(err: unknown): string {
  const e = err as { code?: unknown; errors?: { code?: unknown }[] } | undefined;
  const codes = [...(e?.errors ?? []).map((x) => x?.code), e?.code].filter((c): c is string => typeof c === 'string');
  const rank = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EHOSTDOWN', 'ENETDOWN', 'EPERM', 'EACCES'];
  for (const r of rank) if (codes.includes(r)) return r;
  return codes[0] ?? '';
}

export type ProbeResult =
  | { kind: 'ssh'; software: string }
  | { kind: 'text'; banner: string }
  | { kind: 'binary'; bytes: number }
  | { kind: 'silent' }
  | { kind: 'closed' }
  | { kind: 'error'; code: string };

/** Facts gathered while connecting; the classifier turns them into a cause. */
export interface DiagnoseFacts {
  stage: ConnStage;
  error?: { message?: string; code?: string | number; level?: string };
  port: number;
  /** The user (or a host change) cancelled the attempt. */
  cancelled?: boolean;
  /** Set when the jump host itself connected but could not open the tunnel. */
  tunnelFailed?: boolean;
  prepCause?: ConnCause;
  /** First and latest login method tried ('password', 'publickey', 'agent', 'keyboard-interactive'). */
  firstMethod?: string;
  lastMethod?: string;
  /** Methods the server listed before any login attempt, and in its latest refusal. */
  initialAllowed?: string[];
  allowed?: string[];
  partial?: boolean;
  /** Whether a method was tried after a partial success. */
  triedAfterPartial?: boolean;
  /** Gatehouse fell back to keyboard-interactive after the configured method was refused. */
  fallback?: boolean;
  agentKeysTried?: number;
  promptCancelled?: boolean;
  promptPending?: boolean;
  hostKeyRejected?: boolean;
  identTimedOut?: boolean;
  probe?: ProbeResult;
  remoteAlgos?: Record<string, string>;
  legacyEnabled?: boolean;
  /** Algorithms Gatehouse can offer with legacy algorithms turned on, by kind. */
  legacyOffer?: Record<string, string[]>;
}

const DNS_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA', 'EDNSTIMEOUT'];
const UNREACHABLE_CODES = ['EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENETDOWN', 'EHOSTDOWN'];

function methodAllowed(method: string, allowed: string[]): boolean {
  const wire = method === 'agent' ? 'publickey' : method;
  return allowed.includes(wire);
}

function keyCause(method: string | undefined): ConnCause {
  return method === 'agent' ? 'auth-agent' : 'auth-key';
}

/** Which login problem a refused login was. */
function diagnoseAuth(f: DiagnoseFacts): { cause: ConnCause; params?: ConnParams } {
  const allowed = f.allowed ?? [];
  const initial = f.initialAllowed?.length ? f.initialAllowed : allowed;
  const first = f.firstMethod;
  const last = f.lastMethod ?? first;
  if (first === 'agent' && !f.agentKeysTried) return { cause: 'agent-empty' };
  // ssh2 does not report partial success for agent keys: the server dropping
  // publickey from its list after the agent's attempt means a key was accepted.
  const agentPartial = last === 'agent' && initial.includes('publickey') && allowed.length > 0 && !allowed.includes('publickey');
  if ((f.partial || agentPartial) && !f.triedAfterPartial) return { cause: 'auth-partial', params: { allowed: allowed.join(', ') } };
  // The server never allowed the configured method (and no allowed fallback was tried).
  if (first && initial.length && !methodAllowed(first, initial) && (last === first || !methodAllowed(last ?? first, allowed))) {
    return { cause: 'auth-method', params: { method: first, allowed: initial.join(', ') } };
  }
  // A password login falls back to keyboard-interactive on many servers; the
  // password is still what was wrong — unless the password already passed (two-step login).
  const method = !f.partial && first === 'password' && last === 'keyboard-interactive' ? 'password' : last;
  switch (method) {
    case 'password':
      return { cause: 'auth-password' };
    case 'publickey':
      return { cause: 'auth-key' };
    case 'agent':
      return { cause: 'auth-agent' };
    case 'keyboard-interactive':
      return { cause: 'auth-interactive' };
  }
  return { cause: 'unknown' };
}

/** Turns what happened into a cause the user can act on. Pure, for testing. */
export function diagnose(f: DiagnoseFacts): { cause: ConnCause; params?: ConnParams } {
  const msg = f.error?.message ?? '';
  const rawCode = f.error?.code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  const level = f.error?.level ?? '';
  const port = f.port;

  if (f.prepCause) return { cause: f.prepCause };
  if (f.cancelled || /connection was cancelled/i.test(msg)) return { cause: 'cancelled' };

  if (f.stage === 'jump') return { cause: f.tunnelFailed ? 'jump-forward' : 'jump' };
  if (level === 'agent') return { cause: 'agent-missing' };
  if (f.stage === 'dns' || DNS_CODES.includes(code)) return { cause: 'dns' };
  // These codes only come from opening the connection, whatever stage was recorded.
  if (code === 'ECONNREFUSED') return { cause: 'refused', params: { port } };
  if (UNREACHABLE_CODES.includes(code)) return { cause: 'unreachable' };
  if (f.stage === 'tcp') {
    if (code === 'ETIMEDOUT' || code === 'ECONNTIMEOUT') return { cause: 'tcp-timeout', params: { port } };
    // macOS reports a connection blocked by the Local Network permission as EPERM/EACCES.
    if (code === 'EPERM' || code === 'EACCES') return { cause: 'unreachable' };
    if (code === 'ECONNRESET' || code === 'EPIPE') return { cause: 'reset', params: { port } };
    return { cause: 'unknown' };
  }

  if (f.hostKeyRejected || /host denied/i.test(msg)) return { cause: 'hostkey-rejected' };

  const authRefused =
    level === 'client-authentication' ||
    /all configured authentication methods failed|too many authentication failures/i.test(msg) ||
    rawCode === 14; // SSH_DISCONNECT_NO_MORE_AUTH_METHODS_AVAILABLE
  // After a refused key Gatehouse tries keyboard-interactive (PAM servers offer
  // it); if that is cancelled or refused too, the key is still the problem.
  if (f.fallback && !f.partial && (f.firstMethod === 'publickey' || f.firstMethod === 'agent') && (authRefused || f.promptCancelled)) {
    return f.firstMethod === 'agent' && !f.agentKeysTried ? { cause: 'agent-empty' } : { cause: keyCause(f.firstMethod) };
  }
  if (f.promptCancelled) return { cause: 'cancelled' };
  // Anything that ends the attempt while a question is open on screen: the
  // server (LoginGraceTime) or our own time limit gave up waiting for an answer.
  if (f.promptPending) return { cause: 'login-timeout' };

  if (f.stage === 'ident') {
    switch (f.probe?.kind) {
      case 'text':
      case 'binary':
        return { cause: 'not-ssh', params: { port } };
      case 'silent':
        return { cause: 'no-greeting', params: { port } };
      case 'ssh':
      case 'closed':
        return { cause: 'reset', params: { port } };
      default:
        return f.identTimedOut ? { cause: 'no-greeting', params: { port } } : { cause: 'reset', params: { port } };
    }
  }

  const noMatch = /no matching (key exchange algorithm|host key format|c->s cipher|s->c cipher|c->s mac|s->c mac|c->s compression|s->c compression)/i.exec(msg);
  if (noMatch) {
    const what = /key exchange/i.test(noMatch[1])
      ? 'kex'
      : /host key/i.test(noMatch[1])
        ? 'hostKey'
        : /cipher/i.test(noMatch[1])
          ? 'cipher'
          : /mac/i.test(noMatch[1])
            ? 'mac'
            : 'compression';
    const offered = f.remoteAlgos?.[what] ?? '';
    // Turning on legacy algorithms only helps if the server offers one of them.
    const candidates = f.legacyOffer?.[what];
    const legacyWouldHelp = !f.legacyEnabled && (!offered || !candidates || offered.split(',').some((a) => candidates.includes(a.trim())));
    return { cause: legacyWouldHelp ? 'algorithms' : 'algorithms-unsupported', params: { what, offered } };
  }

  if (level === 'client-timeout' || /timed out while waiting for handshake/i.test(msg)) return { cause: 'handshake-timeout' };
  if (authRefused) return diagnoseAuth(f);

  if (code === 'ECONNRESET' || code === 'EPIPE' || /connection lost before handshake|closed during setup|no response from server/i.test(msg) || typeof rawCode === 'number') {
    return { cause: 'closed-during-setup' };
  }
  return { cause: 'unknown' };
}

/** One attempt in progress. Steps and facts are added as the connection advances. */
export class ConnTrace {
  readonly attempt: ConnAttempt;
  stage: ConnStage = 'prepare';
  private readonly t0 = Date.now();
  private recording = true;
  private finished = false;
  /** Called once the server's SSH greeting arrives. */
  onIdent?: () => void;

  // Facts for the classifier.
  cancelled = false;
  firstMethod?: string;
  lastMethod?: string;
  initialAllowed?: string[];
  allowed?: string[];
  /** The server's latest login refusal, as read from the protocol log (covers agent attempts). */
  latestRefusal?: string[];
  partial = false;
  triedAfterPartial = false;
  fallback = false;
  promptCancelled = false;
  promptPending = false;
  hostKeyRejected = false;
  identTimedOut = false;
  tunnelFailed = false;
  probe?: ProbeResult;
  remoteAlgos: Record<string, string> = {};
  agentKeysTried = 0;
  legacyEnabled = false;
  legacyOffer?: Record<string, string[]>;
  /** Addresses the name resolved to, and the one the connection actually used. */
  addresses: string[] = [];
  connectedAddress?: string;

  constructor(
    private readonly owner: ConnLog,
    attempt: ConnAttempt,
  ) {
    this.attempt = attempt;
  }

  get done(): boolean {
    return this.finished;
  }

  elapsed(): number {
    return Date.now() - this.t0;
  }

  /** Adds a timeline step. Ignored once the attempt has finished (rekeys re-verify the host key). */
  step(code: ConnStepCode, status: ConnStep['status'], params?: ConnParams) {
    if (this.finished || this.attempt.steps.length >= MAX_STEPS) return;
    this.attempt.steps.push({ at: this.elapsed(), code, status, params: cleanParams(params) });
    this.owner.touched(this, false);
  }

  /** ssh2's protocol log. Recorded until the attempt finishes, then ignored (it is per-packet afterwards). */
  debug = (raw: string) => {
    if (!this.recording) return;
    const line = cleanServerText(raw, MAX_LOG_LINE);
    if (this.attempt.log && this.attempt.log.length < MAX_LOG_LINES) this.attempt.log.push(line);
    let m: RegExpExecArray | null;
    if ((m = /^Remote ident: (['"])(.*)\1$/.exec(raw))) {
      const ident = m[2].replace(/\\r|\\n/g, '').trim();
      const software = cleanServerText(ident.replace(/^SSH-[^-]+-/, ''), 120);
      this.attempt.server = software;
      this.step('ident', 'ok', { software });
      this.onIdent?.();
    } else if ((m = /^Handshake: \(remote\) (KEX method|Host key format|C->S cipher|C->S MAC|C->S compression): (.*)$/.exec(raw))) {
      const key = m[1] === 'KEX method' ? 'kex' : m[1] === 'Host key format' ? 'hostKey' : m[1] === 'C->S cipher' ? 'cipher' : m[1] === 'C->S MAC' ? 'mac' : 'compression';
      this.remoteAlgos[key] = cleanMethods(m[2].split(',')).join(',');
    } else if ((m = /^Inbound: Received USERAUTH_FAILURE \((.*)\)$/.exec(raw))) {
      this.latestRefusal = cleanMethods(m[1].split(','));
    } else if ((m = /^Agent: Trying key #(\d+)/.exec(raw))) {
      this.agentKeysTried = Math.max(this.agentKeysTried, Number(m[1]));
    }
  };

  facts(error: unknown, port: number): DiagnoseFacts {
    const e = error as { message?: string; code?: string | number; level?: string } | undefined;
    const code = typeof e?.code === 'number' ? e.code : errorCode(error);
    return {
      stage: this.stage,
      error: e ? { message: e.message, code, level: e.level } : undefined,
      port,
      cancelled: this.cancelled,
      tunnelFailed: this.tunnelFailed,
      prepCause: error instanceof ConnPrepError ? error.connCause : undefined,
      firstMethod: this.firstMethod,
      lastMethod: this.lastMethod,
      initialAllowed: this.initialAllowed,
      allowed: this.allowed,
      partial: this.partial,
      triedAfterPartial: this.triedAfterPartial,
      fallback: this.fallback,
      agentKeysTried: this.agentKeysTried,
      promptCancelled: this.promptCancelled,
      promptPending: this.promptPending,
      hostKeyRejected: this.hostKeyRejected,
      identTimedOut: this.identTimedOut,
      probe: this.probe,
      remoteAlgos: this.remoteAlgos,
      legacyEnabled: this.legacyEnabled,
      legacyOffer: this.legacyOffer,
    };
  }

  /** Records success. The protocol log is dropped: it is only kept to explain failures. */
  connected() {
    if (this.finished) return;
    this.finished = true;
    this.recording = false;
    this.stage = 'ready';
    const ms = this.elapsed();
    this.attempt.steps.push({ at: ms, code: 'ready', status: 'ok', params: { ms } });
    this.attempt.outcome = 'connected';
    this.attempt.durationMs = ms;
    delete this.attempt.log;
    this.owner.touched(this, true);
  }

  /** Records the failure and returns the error to throw (English summary as its message). */
  failed(err: unknown, port: number): ConnectError {
    if (err instanceof ConnectError && err.attemptId === this.attempt.id) return err;
    const { cause, params } = diagnose(this.facts(err, port));
    const raw = err instanceof Error ? err.message : err === undefined ? '' : String(err);
    let message = connCauseMessage(cause, params);
    if (cause === 'auth-method' && params?.allowed) message += ` (the server accepts: ${params.allowed})`;
    // Our own errors before any server contact (a jump-host loop, an unreadable
    // key…) say more than "The connection failed". Server text never goes here.
    const local = this.stage === 'prepare' && err instanceof Error && !(err instanceof ConnPrepError);
    if (cause === 'unknown' && local && raw) message = cleanServerText(raw, 200);
    if (!this.finished) {
      this.finished = true;
      this.recording = false;
      const at = this.elapsed();
      if ((cause === 'algorithms' || cause === 'algorithms-unsupported') && params) {
        this.attempt.steps.push({ at, code: 'kex-fail', status: 'fail', params: cleanParams({ what: params.what, offered: params.offered || '?' }) });
      }
      this.attempt.outcome = 'failed';
      this.attempt.cause = cause;
      this.attempt.causeParams = cleanParams(params);
      this.attempt.message = message;
      if (raw && raw !== message) this.attempt.error = cleanServerText(raw, 500);
      this.attempt.durationMs = at;
      this.attempt.steps.push({ at, code: 'failed', status: 'fail' });
      this.owner.touched(this, true);
    }
    return new ConnectError(message, cause, params, this.attempt.id);
  }

  /** A connection that had been established has ended. */
  ended(kind: 'closed' | 'dropped', reason?: string) {
    if (this.attempt.outcome !== 'connected' || this.attempt.endedAt) return;
    this.attempt.endedAt = Date.now();
    this.attempt.endCause = kind;
    if (reason) this.attempt.endError = reason.slice(0, 300);
    this.attempt.steps.push({
      at: this.elapsed(),
      code: kind === 'dropped' ? 'dropped' : 'closed',
      status: kind === 'dropped' ? 'fail' : 'info',
      params: kind === 'dropped' ? { reason: (reason ?? CONN_DROP_TEXT.closed).slice(0, MAX_PARAM) } : undefined,
    });
    this.owner.touched(this, true);
  }
}

/** Why a jump host could not open a tunnel, as English UI text (from ssh2's reason code). */
export function tunnelReason(err: { reason?: unknown }): string {
  switch (err.reason) {
    case 1:
      return CONN_TUNNEL_TEXT.prohibited;
    case 2:
      return CONN_TUNNEL_TEXT.connect;
    case 3:
      return CONN_TUNNEL_TEXT.type;
    case 4:
      return CONN_TUNNEL_TEXT.resources;
    default:
      return CONN_TUNNEL_TEXT.other;
  }
}

interface LogFile {
  version: 1;
  attempts: ConnAttempt[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates and tidies an attempt read from disk; returns null for anything malformed. */
function loadAttempt(raw: unknown): ConnAttempt | null {
  if (!isPlain(raw)) return null;
  const a = raw as unknown as ConnAttempt;
  if (
    typeof a.id !== 'string' ||
    typeof a.hostId !== 'string' ||
    typeof a.startedAt !== 'number' ||
    !Array.isArray(a.steps) ||
    !isPlain(a.target) ||
    typeof a.target.hostname !== 'string' ||
    !(a.outcome === 'connecting' || a.outcome === 'connected' || a.outcome === 'failed')
  ) {
    return null;
  }
  a.hostLabel = typeof a.hostLabel === 'string' ? a.hostLabel : '';
  a.hostAlias = typeof a.hostAlias === 'string' ? a.hostAlias : '';
  a.steps = (a.steps as unknown[])
    .filter((s): s is ConnStep => isPlain(s) && typeof s.at === 'number' && typeof s.code === 'string' && ['ok', 'fail', 'info'].includes(String(s.status)))
    .map((s) => ({ at: s.at, code: s.code, status: s.status, params: isPlain(s.params) ? cleanParams(s.params as ConnParams) : undefined }))
    .slice(0, MAX_STEPS + 2);
  a.log = Array.isArray(a.log) ? a.log.filter((l): l is string => typeof l === 'string').slice(0, MAX_LOG_LINES) : undefined;
  // An attempt still "connecting" means Gatehouse quit before it finished.
  if (a.outcome === 'connecting') {
    a.outcome = 'failed';
    a.cause = 'interrupted';
    a.causeParams = undefined;
    a.message = connCauseMessage('interrupted');
  }
  // A connection open when Gatehouse quit ended then (the time is not known).
  if (a.outcome === 'connected' && !a.endedAt) {
    a.endedAt = a.startedAt + (a.durationMs ?? 0);
    a.endCause = 'closed';
  }
  return a;
}

/** Keeps recent attempts in memory and (optionally) in a private JSON file. */
export class ConnLog extends EventEmitter {
  private attempts: ConnAttempt[] = [];
  private readonly writer?: DebouncedWriter;

  constructor(path?: string) {
    super();
    if (path) {
      const file = readJsonSync<LogFile>(path);
      if (file && Array.isArray(file.attempts)) {
        this.attempts = file.attempts.map(loadAttempt).filter((a): a is ConnAttempt => !!a).slice(0, MAX_ATTEMPTS);
      }
      this.writer = new DebouncedWriter(path, () => JSON.stringify({ version: 1, attempts: this.attempts } satisfies LogFile), 400);
    }
  }

  begin(host: Host, initiatedBy: 'user' | 'ai', via?: { alias: string; id: string }): ConnTrace {
    const attempt: ConnAttempt = {
      id: randomUUID(),
      hostId: host.id,
      hostLabel: host.name || host.alias,
      hostAlias: host.alias,
      target: { hostname: host.hostname, port: host.port, username: host.username },
      via: via?.alias,
      viaHostId: via?.id,
      initiatedBy,
      startedAt: Date.now(),
      outcome: 'connecting',
      steps: [],
      log: [],
    };
    this.attempts.unshift(attempt);
    const trace = new ConnTrace(this, attempt);
    trace.legacyEnabled = host.legacyAlgorithms;
    this.touched(trace, true);
    return trace;
  }

  /** Called by traces when they change; `outcome` marks changes the UI cares about. */
  touched(trace: ConnTrace, outcome: boolean) {
    // The host was deleted while this attempt was running: keep nothing of it.
    if (!this.attempts.includes(trace.attempt)) return;
    if (outcome) this.trim();
    this.writer?.schedule();
    if (outcome) this.emit('change');
  }

  private trim() {
    const perHost = new Map<string, number>();
    let withLog = 0;
    const kept: ConnAttempt[] = [];
    for (const a of this.attempts) {
      const n = (perHost.get(a.hostId) ?? 0) + 1;
      perHost.set(a.hostId, n);
      // Never drop an attempt that is still running.
      if (a.outcome !== 'connecting' && (n > MAX_PER_HOST || kept.length >= MAX_ATTEMPTS)) continue;
      if (a.log && a.outcome === 'failed') {
        withLog++;
        if (withLog > MAX_WITH_LOG) delete a.log;
      }
      kept.push(a);
    }
    this.attempts = kept;
  }

  private summary(a: ConnAttempt): ConnAttempt {
    const { log, ...rest } = a;
    return { ...JSON.parse(JSON.stringify(rest)), logLines: log?.length ?? 0 } as ConnAttempt;
  }

  /** Newest first, without the protocol log. */
  list(hostId?: string): ConnAttempt[] {
    return this.attempts.filter((a) => !hostId || a.hostId === hostId).map((a) => this.summary(a));
  }

  get(id: string): ConnAttempt | undefined {
    const a = this.attempts.find((x) => x.id === id);
    return a ? (JSON.parse(JSON.stringify(a)) as ConnAttempt) : undefined;
  }

  latest(hostId: string): ConnAttempt | undefined {
    const a = this.attempts.find((x) => x.hostId === hostId);
    return a ? this.summary(a) : undefined;
  }

  statuses(): Record<string, ConnStatus> {
    const out: Record<string, ConnStatus> = {};
    for (const a of this.attempts) {
      if (out[a.hostId]) continue;
      out[a.hostId] = { attemptId: a.id, outcome: a.outcome, cause: a.cause, causeParams: a.causeParams, at: a.startedAt, dropped: a.endCause === 'dropped' || undefined };
    }
    return out;
  }

  /** "Clear history": keeps attempts still running and connections still open (they are still in use). */
  clear(hostId: string) {
    const before = this.attempts.length;
    this.attempts = this.attempts.filter((a) => a.hostId !== hostId || a.outcome === 'connecting' || (a.outcome === 'connected' && !a.endedAt));
    if (this.attempts.length !== before) {
      this.writer?.schedule();
      this.emit('change');
    }
  }

  /** A deleted host: remove everything, including attempts still running. */
  forget(hostId: string) {
    const before = this.attempts.length;
    this.attempts = this.attempts.filter((a) => a.hostId !== hostId);
    if (this.attempts.length !== before) {
      this.writer?.schedule();
      this.emit('change');
    }
  }

  flushSync() {
    this.writer?.flushSync();
  }
}

/** Looks a name up (with a time limit), recording the result. */
export async function resolveHost(hostname: string, trace: ConnTrace, timeoutMs = DNS_TIMEOUT_MS): Promise<dns.LookupAddress[]> {
  const family = net.isIP(hostname);
  if (family) return [{ address: hostname, family }];
  trace.stage = 'dns';
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      // The same hint net.connect() uses: skip address families this Mac has no address for.
      dns.promises.lookup(hostname, { all: true, hints: dns.ADDRCONFIG }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Looking up ${hostname} timed out`), { code: 'EDNSTIMEOUT' })), timeoutMs);
      }),
    ]);
    if (!addresses.length) throw Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' });
    trace.step('dns-ok', 'ok', {
      name: hostname,
      addresses: addresses.slice(0, 4).map((a) => a.address).join(', ') + (addresses.length > 4 ? ' …' : ''),
      ms: Date.now() - started,
    });
    return addresses;
  } catch (err) {
    trace.step('dns-fail', 'fail', { name: hostname, code: errorCode(err) || 'error' });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Opens the TCP connection ssh2 will run over, recording how it went. */
export function openSocket(hostname: string, port: number, addresses: dns.LookupAddress[], trace: ConnTrace, timeoutMs = TCP_TIMEOUT_MS): Promise<net.Socket> {
  trace.stage = 'tcp';
  trace.addresses = addresses.map((a) => a.address);
  const started = Date.now();
  const shown = addresses.length === 1 ? addresses[0].address : hostname;
  return new Promise((resolve, reject) => {
    const sock = net.connect({
      host: hostname,
      port,
      // Reuse the addresses just looked up instead of asking DNS again.
      lookup: ((_name: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        if (opts?.all) cb(null, addresses);
        else cb(null, addresses[0].address, addresses[0].family);
      }) as unknown as net.LookupFunction,
      autoSelectFamily: addresses.length > 1,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      trace.step('tcp-timeout', 'fail', { address: shown, port, sec: Math.round(timeoutMs / 1000) });
      reject(Object.assign(new Error(`connect ETIMEDOUT ${port}`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      trace.connectedAddress = sock.remoteAddress ?? undefined;
      trace.step('tcp-ok', 'ok', { address: sock.remoteAddress ?? shown, port, ms: Date.now() - started });
      resolve(sock);
    });
    sock.once('error', (err: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = errorCode(err) || 'error';
      if (code === 'ETIMEDOUT') trace.step('tcp-timeout', 'fail', { address: shown, port, sec: Math.round((Date.now() - started) / 1000) });
      else trace.step('tcp-fail', 'fail', { address: shown, port, code });
      reject(Object.assign(err, { code }));
    });
  });
}

/**
 * Second look at a port that accepted a connection but never spoke SSH: waits
 * briefly for a greeting, then sends an SSH greeting of its own and reads the
 * reply. Tells "wrong port" apart from "server dropping connections".
 */
export function probePort(address: string, port: number, waitMs = 1500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    let sentHello = false;
    const sock = net.connect({ host: address, port });
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const classify = (): ProbeResult => {
      const text = buf.toString('latin1');
      const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
      if (/^SSH-\d/.test(firstLine)) return { kind: 'ssh', software: cleanServerText(firstLine.replace(/^SSH-[^-]+-/, ''), 120) };
      const printable = [...firstLine].filter((c) => c >= ' ' && c <= '~').length;
      if (firstLine.length && printable / firstLine.length > 0.8) return { kind: 'text', banner: cleanServerText(firstLine, 80) };
      return { kind: 'binary', bytes: buf.length };
    };
    let timer = setTimeout(() => finish({ kind: 'error', code: 'ETIMEDOUT' }), waitMs * 2);
    sock.once('connect', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (buf.length) return finish(classify());
        if (!sentHello) {
          // Many services only answer once the client speaks first.
          sentHello = true;
          sock.write('SSH-2.0-Gatehouse_check\r\n');
          timer = setTimeout(() => finish(buf.length ? classify() : { kind: 'silent' }), waitMs);
        }
      }, waitMs);
    });
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]).subarray(0, 1024);
      if (buf.includes(10) || buf.length >= 512) finish(classify());
    });
    sock.once('error', (err: Error & { code?: string }) => finish(buf.length ? classify() : { kind: 'error', code: err.code ?? 'error' }));
    sock.once('close', () => finish(buf.length ? classify() : { kind: 'closed' }));
  });
}
