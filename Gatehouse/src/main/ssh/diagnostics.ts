// Connection diagnostics: every attempt to open an SSH connection is traced step
// by step (look-up, network connection, SSH greeting, encryption, server
// identity, login) and, when it fails, given a cause the user can act on.
//
// What is recorded never includes secrets: passwords, passphrases, answers and
// key material are not passed in, and ssh2's protocol log does not print them.
// Host names, addresses and user names are recorded — the log is the user's own,
// stored privately on this Mac, and is never shown to Claude.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import type { ConnAttempt, ConnCause, ConnParams, ConnStatus, ConnStepCode, Host } from '../../shared/types';
import { CONN_DROP_TEXT, connCauseMessage } from '../../shared/conn-text';
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
export const IDENT_TIMEOUT_MS = 30_000;

/** A failed connection, with the diagnosis. `message` is the English summary. */
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

/** English text for why a live connection ended (a key of CONN_DROP_TEXT, translated in the UI). */
export function dropReason(err: unknown): string {
  const e = err as { message?: string; code?: string; level?: string } | undefined;
  const msg = e?.message ?? '';
  const code = e?.code ?? '';
  if (!e) return CONN_DROP_TEXT.closed;
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

/** Strips control and bidi-override characters from text a server sent, and caps its length. */
export function cleanServerText(text: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cleanParams(params?: ConnParams): ConnParams | undefined {
  if (!params) return undefined;
  const out: ConnParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'number' ? v : String(v).slice(0, MAX_PARAM);
  }
  return out;
}

export type ProbeResult =
  | { kind: 'ssh'; software: string }
  | { kind: 'text'; banner: string }
  | { kind: 'silent' }
  | { kind: 'closed' }
  | { kind: 'error'; code: string };

/** Facts gathered while connecting; the classifier turns them into a cause. */
export interface DiagnoseFacts {
  stage: ConnStage;
  error?: { message?: string; code?: string; level?: string };
  port: number;
  via?: string;
  /** Set when the jump host itself connected but could not open the tunnel. */
  tunnelFailed?: boolean;
  prepCause?: ConnCause;
  /** First and latest login method tried ('password', 'publickey', 'agent', 'keyboard-interactive'). */
  firstMethod?: string;
  lastMethod?: string;
  /** Methods the server said can continue, from its latest refusal. */
  allowed?: string[];
  partial?: boolean;
  /** Whether a method was tried after a partial success. */
  triedAfterPartial?: boolean;
  promptCancelled?: boolean;
  promptPending?: boolean;
  hostKeyRejected?: boolean;
  identTimedOut?: boolean;
  probe?: ProbeResult;
  remoteAlgos?: Record<string, string>;
  legacyEnabled?: boolean;
}

const LEGACY_NAMES = /sha1|cbc|ssh-rsa$|ssh-dss|3des|group1-|group14-sha1|hmac-md5/i;

function methodAllowed(method: string, allowed: string[]): boolean {
  const wire = method === 'agent' ? 'publickey' : method;
  return allowed.includes(wire);
}

/** Turns what happened into a cause the user can act on. Pure, for testing. */
export function diagnose(f: DiagnoseFacts): { cause: ConnCause; params?: ConnParams } {
  const msg = f.error?.message ?? '';
  const code = f.error?.code ?? '';
  const level = f.error?.level ?? '';
  const port = f.port;

  if (f.prepCause) return { cause: f.prepCause };
  if (/connection was cancelled/i.test(msg)) return { cause: 'cancelled' };

  if (f.stage === 'jump') {
    if (f.tunnelFailed) return { cause: 'jump-forward' };
    return { cause: 'jump', params: { jump: f.via ?? '' } };
  }
  if (f.stage === 'dns' || ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA', 'EDNSTIMEOUT'].includes(code)) {
    return { cause: 'dns' };
  }
  // These codes only come from opening the connection, whatever stage was recorded.
  if (code === 'ECONNREFUSED') return { cause: 'refused', params: { port } };
  if (['EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENETDOWN', 'EHOSTDOWN'].includes(code)) return { cause: 'unreachable' };
  if (f.stage === 'tcp') {
    if (code === 'ETIMEDOUT' || code === 'ECONNTIMEOUT') return { cause: 'tcp-timeout', params: { port } };
    // macOS reports a connection blocked by the Local Network permission as EPERM/EACCES.
    if (code === 'EPERM' || code === 'EACCES') return { cause: 'unreachable' };
    if (code === 'ECONNRESET' || code === 'EPIPE') return { cause: 'reset', params: { port } };
    return { cause: 'unknown' };
  }

  if (f.hostKeyRejected || /host denied/i.test(msg)) return { cause: 'hostkey-rejected' };
  if (f.promptCancelled) return { cause: 'cancelled' };

  if (f.stage === 'ident') {
    switch (f.probe?.kind) {
      case 'text':
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
    const legacyWouldHelp = !f.legacyEnabled && (!offered || offered.split(',').some((a) => LEGACY_NAMES.test(a)));
    return { cause: legacyWouldHelp ? 'algorithms' : 'algorithms-unsupported', params: { what, offered } };
  }

  if (level === 'client-timeout' || /timed out while waiting for handshake/i.test(msg)) {
    if (f.promptPending) return { cause: 'cancelled' };
    return { cause: 'handshake-timeout' };
  }

  if (f.stage === 'auth' || level === 'client-authentication' || /all configured authentication methods failed/i.test(msg)) {
    const allowed = f.allowed ?? [];
    const list = allowed.join(', ');
    if (f.partial && !f.triedAfterPartial) return { cause: 'auth-partial', params: { allowed: list } };
    const first = f.firstMethod;
    const last = f.lastMethod ?? first;
    // The server never allowed the configured method (and no allowed fallback was tried).
    if (first && allowed.length && !methodAllowed(first, allowed) && (last === first || !methodAllowed(last ?? first, allowed))) {
      return { cause: 'auth-method', params: { method: first, allowed: list } };
    }
    // A password login falls back to keyboard-interactive on many servers; the
    // password is still what was wrong.
    const method = first === 'password' && last === 'keyboard-interactive' ? 'password' : last;
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

  if (code === 'ECONNRESET' || code === 'EPIPE' || /connection lost before handshake|closed during setup|no response from server/i.test(msg)) {
    return { cause: 'reset', params: { port } };
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
  firstMethod?: string;
  lastMethod?: string;
  allowed?: string[];
  partial = false;
  triedAfterPartial = false;
  promptCancelled = false;
  promptPending = false;
  hostKeyRejected = false;
  identTimedOut = false;
  tunnelFailed = false;
  probe?: ProbeResult;
  remoteAlgos: Record<string, string> = {};
  agentKeysTried = 0;
  legacyEnabled = false;
  /** Addresses the name resolved to (for the network probe). */
  addresses: string[] = [];

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

  step(code: ConnStepCode, status: 'ok' | 'fail' | 'info', params?: ConnParams) {
    if (this.attempt.steps.length >= MAX_STEPS) return;
    this.attempt.steps.push({ at: this.elapsed(), code, status, params: cleanParams(params) });
    this.owner.touched(this, false);
  }

  /** ssh2's protocol log. Recorded until the attempt finishes, then ignored (it is per-packet afterwards). */
  debug = (line: string) => {
    if (!this.recording) return;
    if (this.attempt.log && this.attempt.log.length < MAX_LOG_LINES) {
      this.attempt.log.push(line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE - 1)}…` : line);
    }
    let m: RegExpExecArray | null;
    if ((m = /^Remote ident: (['"])(.*)\1$/.exec(line))) {
      const ident = m[2].replace(/\\r|\\n/g, '').trim();
      const software = cleanServerText(ident.replace(/^SSH-[^-]+-/, ''), 120);
      this.attempt.server = software;
      this.step('ident', 'ok', { software });
      this.onIdent?.();
    } else if ((m = /^Handshake: \(remote\) (KEX method|Host key format|C->S cipher|C->S MAC|C->S compression): (.*)$/.exec(line))) {
      const key = m[1] === 'KEX method' ? 'kex' : m[1] === 'Host key format' ? 'hostKey' : m[1] === 'C->S cipher' ? 'cipher' : m[1] === 'C->S MAC' ? 'mac' : 'compression';
      this.remoteAlgos[key] = m[2].slice(0, 400);
    } else if ((m = /^Agent: Trying key #(\d+)/.exec(line))) {
      this.agentKeysTried = Math.max(this.agentKeysTried, Number(m[1]));
    }
  };

  facts(error: unknown, port: number): DiagnoseFacts {
    const e = error as { message?: string; code?: string; level?: string; errors?: { code?: string }[]; connCause?: ConnCause } | undefined;
    return {
      stage: this.stage,
      error: e ? { message: e.message, code: e.code ?? e.errors?.find((x) => x?.code)?.code, level: e.level } : undefined,
      port,
      via: this.attempt.via,
      tunnelFailed: this.tunnelFailed,
      prepCause: error instanceof ConnPrepError ? error.connCause : undefined,
      firstMethod: this.firstMethod,
      lastMethod: this.lastMethod,
      allowed: this.allowed,
      partial: this.partial,
      triedAfterPartial: this.triedAfterPartial,
      promptCancelled: this.promptCancelled,
      promptPending: this.promptPending,
      hostKeyRejected: this.hostKeyRejected,
      identTimedOut: this.identTimedOut,
      probe: this.probe,
      remoteAlgos: this.remoteAlgos,
      legacyEnabled: this.legacyEnabled,
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
    if (!this.finished) {
      this.finished = true;
      this.recording = false;
      this.attempt.outcome = 'failed';
      this.attempt.cause = cause;
      this.attempt.causeParams = cleanParams(params);
      this.attempt.message = message;
      if (raw && raw !== message) this.attempt.error = raw.slice(0, 500);
      this.attempt.durationMs = this.elapsed();
      this.attempt.steps.push({ at: this.attempt.durationMs, code: 'failed', status: 'fail' });
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
      params: kind === 'dropped' ? { reason: (reason ?? 'unknown').slice(0, MAX_PARAM) } : undefined,
    });
    this.owner.touched(this, true);
  }
}

interface LogFile {
  version: 1;
  attempts: ConnAttempt[];
}

function validAttempt(a: unknown): a is ConnAttempt {
  const x = a as ConnAttempt;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.hostId === 'string' &&
    typeof x.startedAt === 'number' &&
    Array.isArray(x.steps) &&
    !!x.target &&
    typeof x.target.hostname === 'string' &&
    (x.outcome === 'connecting' || x.outcome === 'connected' || x.outcome === 'failed')
  );
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
        this.attempts = file.attempts.filter(validAttempt).slice(0, MAX_ATTEMPTS);
        for (const a of this.attempts) {
          // An attempt still "connecting" means Gatehouse quit before it finished.
          if (a.outcome === 'connecting') {
            a.outcome = 'failed';
            a.cause = 'cancelled';
            a.message = connCauseMessage('cancelled');
          }
          // A connection open when Gatehouse quit ended then.
          if (a.outcome === 'connected' && !a.endedAt) {
            a.endedAt = a.startedAt + (a.durationMs ?? 0);
            a.endCause = 'closed';
          }
        }
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
  touched(_trace: ConnTrace, outcome: boolean) {
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

  clear(hostId?: string) {
    const before = this.attempts.length;
    // Running attempts stay: their traces still write to them.
    this.attempts = this.attempts.filter((a) => a.outcome === 'connecting' || (hostId !== undefined && a.hostId !== hostId));
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
      dns.promises.lookup(hostname, { all: true }),
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
    trace.step('dns-fail', 'fail', { name: hostname, code: (err as { code?: string }).code ?? 'error' });
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
      trace.step('tcp-ok', 'ok', { address: sock.remoteAddress ?? shown, port, ms: Date.now() - started });
      resolve(sock);
    });
    sock.once('error', (err: Error & { code?: string; errors?: { code?: string }[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = err.code ?? err.errors?.find((x) => x?.code)?.code ?? 'error';
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
      return { kind: 'text', banner: `(${buf.length} bytes of binary data)` };
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
