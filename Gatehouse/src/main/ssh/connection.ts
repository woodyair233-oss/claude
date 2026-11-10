// Shared SSH connections ("ControlMaster" style): terminals, SFTP, tunnels
// and AI commands to the same host reuse one authenticated connection.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import type { AnyAuthMethod, Client as ClientType, ConnectConfig } from 'ssh2';
import type { Host } from '../../shared/types';
import type { Store } from '../store';
import type { Vault } from '../vault';
import type { PromptBroker } from '../prompts';
import { blobKeyType, fingerprintBlob, KeyError, parsePrivateKey } from './keys';
import { checkSystemKnownHosts } from './known-hosts';
import { cleanMethods, cleanServerText, ConnLog, ConnPrepError, ConnTrace, dropReason, IDENT_TIMEOUT_MS, keyTypeLabel, openSocket, probePort, resolveHost, tunnelReason } from './diagnostics';
// ssh2 keeps its algorithm tables here; used to drop names this runtime cannot use.
import constants from 'ssh2/lib/protocol/constants.js';
import { isWindowsServerSoftware } from '../../shared/shells';


const { Client } = ssh2;

export type Initiator = 'user' | 'ai';

const IDLE_MS = 5 * 60_000;
const MAX_JUMP_DEPTH = 5;

const HARDENED = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group14-sha256',
  ],
  cipher: [
    'chacha20-poly1305@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-gcm@openssh.com',
    'aes256-ctr',
    'aes192-ctr',
    'aes128-ctr',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512'],
};

const LEGACY = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'],
  cipher: ['aes256-cbc', 'aes192-cbc', 'aes128-cbc', '3des-cbc'],
  serverHostKey: ['ssh-rsa', 'ssh-dss'],
  hmac: ['hmac-sha1'],
};

/** Everything Gatehouse could offer with legacy algorithms on, by kind (for the diagnosis). */
let legacyOfferCache: Record<string, string[]> | undefined;
function legacyOffer(): Record<string, string[]> {
  if (!legacyOfferCache) {
    const a = algorithms(true) as unknown as Record<'kex' | 'cipher' | 'serverHostKey' | 'hmac', string[]>;
    legacyOfferCache = { kex: a.kex, hostKey: a.serverHostKey, cipher: a.cipher, mac: a.hmac };
  }
  return legacyOfferCache;
}

function algorithms(legacy: boolean): ConnectConfig['algorithms'] {
  const pick = (list: string[], supported: string[]) => list.filter((a) => supported.includes(a));
  const merge = (a: string[], b: string[]) => (legacy ? [...a, ...b] : a);
  return {
    kex: pick(merge(HARDENED.kex, LEGACY.kex), constants.SUPPORTED_KEX),
    cipher: pick(merge(HARDENED.cipher, LEGACY.cipher), constants.SUPPORTED_CIPHER),
    serverHostKey: pick(merge(HARDENED.serverHostKey, LEGACY.serverHostKey), constants.SUPPORTED_SERVER_HOST_KEY),
    hmac: pick(merge(HARDENED.hmac, LEGACY.hmac), constants.SUPPORTED_MAC),
  } as ConnectConfig['algorithms'];
}

/** Guards against servers announcing a zero packet size (ssh2 #1504 busy-loops on it). */
export function assertSaneChannel(channel: unknown) {
  const size = (channel as { outgoing?: { packetSize?: number } })?.outgoing?.packetSize;
  if (typeof size === 'number' && size < 9) {
    (channel as { close?: () => void }).close?.();
    throw new Error('The server announced an invalid channel packet size.');
  }
}

export function friendlySshError(err: unknown): string {
  const e = err as { message?: string; code?: string; level?: string };
  const msg = e?.message ?? String(err);
  if (e?.level === 'client-authentication' || /All configured authentication methods failed/i.test(msg)) {
    return 'Authentication failed. Check the username, key or password.';
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return 'Host not found. Check the hostname.';
  if (e?.code === 'ECONNREFUSED') return 'Connection refused. Is SSH running on that port?';
  if (e?.code === 'ETIMEDOUT' || /timed out/i.test(msg)) return 'Connection timed out.';
  if (e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') return 'Host unreachable. Check the network (and Local Network permission on macOS).';
  if (/host key|Host denied/i.test(msg)) return 'The host key was not accepted.';
  if (/handshake failed|no matching/i.test(msg)) return `${msg}. Try enabling legacy algorithms for this host.`;
  return msg;
}

interface Pooled {
  hostId: string;
  client: ClientType;
  ready: Promise<ClientType>;
  refs: number;
  idleTimer?: NodeJS.Timeout;
  closed: boolean;
  releaseJump?: () => void;
  connectedAt?: number;
  /** The connection-log entry for the attempt that opened this connection. */
  trace: ConnTrace;
  /** Why a live connection failed, if it did (recorded when it closes). */
  lastError?: string;
  /** The transport under ssh2 (our TCP socket or the jump host's channel), to abort a pending attempt. */
  sock?: { destroy(): void };
  /** Clears a saved password the server refused. */
  rollback?: () => Promise<void>;
  /** Closes the questions this attempt has on screen when it is cancelled. */
  abort: AbortController;
}

export interface Lease {
  client: ClientType;
  host: Host;
  /** Connection-log entry of the attempt that opened this connection. */
  attemptId: string;
  release: () => void;
}

/** Auth methods for a connection, plus hooks run after it succeeds or fails. */
interface AuthPlan {
  methods: AnyAuthMethod[];
  /** Run once the connection is ready (e.g. persist a password that worked). */
  commit?: () => Promise<void>;
  /** Run if the connection fails before ready (e.g. clear a stale saved password). */
  rollback?: () => Promise<void>;
}

export interface ConnectionDeps {
  store: Store;
  vault: Vault;
  prompts: PromptBroker;
  /** Where attempts are recorded; an in-memory log is used when omitted. */
  connLog?: ConnLog;
  /** Overrides for the diagnostic time limits (tests). */
  timeouts?: { dnsMs?: number; tcpMs?: number; identMs?: number; probeMs?: number };
}

export class ConnectionManager extends EventEmitter {
  private pool = new Map<string, Pooled>();
  readonly connLog: ConnLog;

  constructor(private readonly deps: ConnectionDeps) {
    super();
    this.connLog = deps.connLog ?? new ConnLog();
  }

  connectedHostIds(): string[] {
    return [...this.pool.values()].filter((p) => p.connectedAt && !p.closed).map((p) => p.hostId);
  }

  isConnected(hostId: string): boolean {
    const p = this.pool.get(hostId);
    return !!p && !!p.connectedAt && !p.closed;
  }

  async acquire(hostId: string, initiatedBy: Initiator, chain: string[] = []): Promise<Lease> {
    const host = this.deps.store.getHost(hostId);
    if (!host) throw new Error('Unknown host');
    let p = this.pool.get(hostId);
    if (!p || p.closed) {
      p = this.dial(host, initiatedBy, chain);
      this.pool.set(hostId, p);
    }
    const pooled = p;
    pooled.refs++;
    if (pooled.idleTimer) {
      clearTimeout(pooled.idleTimer);
      pooled.idleTimer = undefined;
    }
    try {
      const client = await pooled.ready;
      let released = false;
      return {
        client,
        host,
        attemptId: pooled.trace.attempt.id,
        release: () => {
          if (released) return;
          released = true;
          this.release(pooled);
        },
      };
    } catch (err) {
      pooled.refs = Math.max(0, pooled.refs - 1);
      if (this.pool.get(hostId) === pooled) this.pool.delete(hostId);
      throw err;
    }
  }

  private release(p: Pooled) {
    p.refs = Math.max(0, p.refs - 1);
    if (p.refs === 0 && !p.closed) {
      p.idleTimer = setTimeout(() => this.disconnect(p.hostId), IDLE_MS);
    }
  }

  disconnect(hostId: string) {
    const p = this.pool.get(hostId);
    if (!p) return;
    p.closed = true;
    this.pool.delete(hostId);
    if (p.idleTimer) clearTimeout(p.idleTimer);
    if (p.connectedAt) {
      // Record the end now: on quit the log is saved before any 'close' event arrives.
      p.trace.ended('closed');
    } else {
      // Still connecting: say so, close any question it has on screen, and
      // abort at once. After end(), ssh2 can no longer destroy the socket
      // itself, and a silent peer would hold it open.
      p.trace.cancelled = true;
      p.abort.abort();
      try {
        p.sock?.destroy();
      } catch {
        /* ignore */
      }
    }
    try {
      p.client.end();
    } catch {
      /* ignore */
    }
    p.releaseJump?.();
    this.emit('change');
  }

  disconnectAll() {
    for (const id of [...this.pool.keys()]) this.disconnect(id);
  }

  private dial(host: Host, initiatedBy: Initiator, chain: string[]): Pooled {
    const client = new Client();
    const jumpHost = host.jumpHostId ? this.deps.store.getHost(host.jumpHostId) : undefined;
    const trace = this.connLog.begin(host, initiatedBy, jumpHost ? { alias: jumpHost.alias, id: jumpHost.id } : undefined);
    trace.legacyOffer = legacyOffer();
    const pooled: Pooled = { hostId: host.id, client, refs: 0, closed: false, ready: Promise.resolve(client), trace, abort: new AbortController() };
    pooled.ready = this.connect(host, client, pooled, initiatedBy, chain).catch(async (err) => {
      // Explain the failure before reporting it: a port that accepted the
      // connection but never spoke SSH gets a second, quick look (at the
      // address that answered) — unless the user cancelled.
      const address = trace.connectedAddress ?? trace.addresses[0];
      if (trace.stage === 'ident' && !trace.cancelled && !host.jumpHostId && address && !trace.done) {
        trace.probe = await probePort(address, host.port, this.deps.timeouts?.probeMs);
        const pr = trace.probe;
        if (pr.kind === 'ssh') trace.step('probe-ssh', 'info', { software: pr.software });
        else if (pr.kind === 'text') trace.step('probe-text', 'info', { banner: pr.banner });
        else if (pr.kind === 'binary') trace.step('probe-binary', 'info', { bytes: pr.bytes });
        else if (pr.kind === 'silent') trace.step('probe-silent', 'info');
        else if (pr.kind === 'closed') trace.step('probe-closed', 'info');
        else trace.step('probe-failed', 'info', { code: pr.code });
      }
      const failure = trace.failed(err, host.port);
      // A saved password the server refused is stale: clear it so the next
      // attempt asks again. Not after a network error, and not when the
      // password passed but a second step (a code) failed.
      if (failure.connCause === 'auth-password' && !trace.partial) await pooled.rollback?.().catch(() => undefined);
      throw failure;
    });
    pooled.ready.catch(() => undefined);
    return pooled;
  }

  private async connect(host: Host, client: ClientType, pooled: Pooled, initiatedBy: Initiator, chain: string[]): Promise<ClientType> {
    const trace = pooled.trace;
    if (chain.includes(host.id)) throw new Error('Jump host loop detected.');
    if (chain.length > MAX_JUMP_DEPTH) throw new Error('Too many chained jump hosts.');
    if (host.jumpHostId && !this.deps.store.getHost(host.jumpHostId)) {
      throw new ConnPrepError('The jump host set for this host no longer exists.', 'jump-missing');
    }

    // Build auth first: a cancelled prompt, locked vault or missing key must not
    // leak the jump-host lease and its forwarded channel.
    const plan = await this.buildAuth(host, initiatedBy, trace, pooled);
    if (pooled.closed) throw new Error('Connection was cancelled.');
    pooled.rollback = plan.rollback;
    // Like OpenSSH, start with "none": the server's reply lists the login
    // methods it accepts, which the diagnosis needs. It is not counted as a failure.
    const authQueue: AnyAuthMethod[] = [{ type: 'none', username: host.username } as AnyAuthMethod, ...plan.methods];
    let triedInteractive = host.auth === 'interactive';

    let sock: NodeJS.ReadableStream | undefined;
    if (host.jumpHostId) {
      trace.stage = 'jump';
      const jumpAlias = trace.attempt.via ?? '';
      let jump: Lease;
      try {
        jump = await this.acquire(host.jumpHostId, initiatedBy, [...chain, host.id]);
      } catch (err) {
        trace.step('jump-fail', 'fail', { jump: jumpAlias });
        throw err;
      }
      trace.step('jump-ok', 'ok', { jump: jumpAlias });
      pooled.releaseJump = jump.release;
      if (pooled.closed) {
        jump.release();
        pooled.releaseJump = undefined;
        throw new Error('Connection was cancelled.');
      }
      try {
        sock = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
          jump.client.forwardOut('127.0.0.1', 0, host.hostname, host.port, (err, stream) => {
            if (err) {
              trace.tunnelFailed = true;
              trace.step('tunnel-fail', 'fail', { port: host.port, reason: tunnelReason(err as { reason?: unknown }) });
              return reject(new Error(`Jump host could not reach ${host.alias}: ${cleanServerText(err.message, 160)}`));
            }
            try {
              assertSaneChannel(stream);
            } catch (e) {
              return reject(e);
            }
            trace.step('tunnel-ok', 'ok', { port: host.port });
            resolve(stream);
          }),
        );
      } catch (err) {
        jump.release();
        pooled.releaseJump = undefined;
        throw err;
      }
    } else {
      // Open the TCP connection here rather than inside ssh2, so a wrong name,
      // a closed port and a silent firewall each get their own diagnosis.
      const addresses = await resolveHost(host.hostname, trace, this.deps.timeouts?.dnsMs);
      if (pooled.closed) throw new Error('Connection was cancelled.');
      const tcp = await openSocket(host.hostname, host.port, addresses, trace, this.deps.timeouts?.tcpMs);
      if (pooled.closed) {
        tcp.destroy();
        throw new Error('Connection was cancelled.');
      }
      sock = tcp;
    }
    pooled.sock = sock as unknown as { destroy(): void };
    trace.stage = 'ident';

    const config: ConnectConfig = {
      host: host.hostname,
      port: host.port,
      username: host.username,
      // Generous: the key-change dialog (type-the-alias) and keyboard-interactive
      // 2FA happen during the handshake and can legitimately take a while.
      readyTimeout: 180_000,
      keepaliveInterval: host.keepAliveSec > 0 ? host.keepAliveSec * 1000 : 0,
      keepaliveCountMax: 4,
      algorithms: algorithms(host.legacyAlgorithms),
      // ssh2's protocol log feeds the connection log (it never prints secrets).
      debug: trace.debug,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        // The attempt may have been cancelled while the question was on screen;
        // answering a connection that is already torn down throws inside ssh2.
        const answer = (ok: boolean) => {
          if (pooled.closed) return;
          try {
            verify(ok);
          } catch {
            /* the connection is gone */
          }
        };
        this.verifyHostKey(host, key, initiatedBy, trace, pooled).then(answer, () => answer(false));
      },
      authHandler: ((methodsLeft: string[] | null, partial: boolean | null, next: (m: AnyAuthMethod | false) => void) => {
        trace.stage = 'auth';
        const label = (m: AnyAuthMethod) => (m.type === 'agent' ? 'agent' : m.type);
        // The server's latest refusal. ssh2 passes it for most methods; after
        // agent keys it passes a stale list, so prefer what the protocol log says.
        const serverList = trace.latestRefusal ?? cleanMethods(methodsLeft);
        // Each call after the first reports how the previous method went.
        if (trace.lastMethod === 'none') {
          trace.initialAllowed = serverList;
          trace.allowed = serverList;
          if (serverList.length) trace.step('auth-methods', 'info', { allowed: serverList.join(', ') });
        } else if (trace.lastMethod) {
          trace.allowed = serverList;
          const agentPartial =
            trace.lastMethod === 'agent' && !!trace.initialAllowed?.includes('publickey') && serverList.length > 0 && !serverList.includes('publickey');
          if (trace.lastMethod === 'agent' && !trace.agentKeysTried) {
            trace.step('agent-empty', 'fail');
          } else if (partial || agentPartial) {
            trace.partial = true;
            trace.step('auth-partial', 'info', { method: trace.lastMethod, allowed: serverList.join(', ') });
          } else {
            trace.step('auth-fail', 'fail', { method: trace.lastMethod, allowed: serverList.join(', ') });
          }
        }
        const tryMethod = (m: AnyAuthMethod, fallback = false) => {
          const name = label(m);
          trace.lastMethod = name;
          if (name !== 'none') {
            trace.firstMethod ??= name;
            if (trace.partial) trace.triedAfterPartial = true;
            else if (fallback) trace.fallback = true;
            trace.step('auth-try', 'info', { user: host.username, method: name });
          }
          return next(m);
        };
        const method = authQueue.shift();
        if (method) return tryMethod(method);
        if (!triedInteractive && serverList.includes('keyboard-interactive')) {
          triedInteractive = true;
          return tryMethod(this.keyboardInteractive(host, initiatedBy, trace, pooled), true);
        }
        trace.step('auth-exhausted', 'fail');
        return next(false);
      }) as unknown as ConnectConfig['authHandler'],
    };
    if (sock) config.sock = sock as ConnectConfig['sock'];

    return new Promise<ClientType>((resolve, reject) => {
      let settled = false;
      // A port that accepts the connection but never sends an SSH greeting would
      // otherwise hang until the long ready timeout.
      const identMs = this.deps.timeouts?.identMs ?? IDENT_TIMEOUT_MS;
      const identTimer = setTimeout(() => {
        if (settled || trace.stage !== 'ident') return;
        trace.identTimedOut = true;
        trace.step('ident-timeout', 'fail', { sec: Math.round(identMs / 1000) });
        try {
          pooled.sock?.destroy();
          client.destroy();
        } catch {
          /* ignore */
        }
      }, identMs);
      trace.onIdent = () => {
        clearTimeout(identTimer);
        if (trace.stage === 'ident') trace.stage = 'kex';
      };
      client.on('handshake', (negotiated: { kex?: string; serverHostKey?: string; cs?: { cipher?: string } }) => {
        if (settled) return;
        trace.step('kex-ok', 'ok', { kex: negotiated.kex ?? '?', cipher: negotiated.cs?.cipher ?? '?', hostKey: negotiated.serverHostKey ?? '?' });
        trace.stage = 'auth';
      });
      client.on('banner', (message: string) => {
        if (settled || !message?.trim()) return;
        trace.step('banner', 'info', { text: cleanServerText(message, 160) });
      });
      client.once('ready', () => {
        settled = true;
        clearTimeout(identTimer);
        if (pooled.closed) {
          try {
            client.end();
          } catch {
            /* ignore */
          }
          reject(new Error('Connection was cancelled.'));
          return;
        }
        pooled.connectedAt = Date.now();
        trace.step('auth-ok', 'ok', { method: trace.lastMethod ?? host.auth });
        trace.connected();
        // The SSH greeting says whether this is a Windows server: commands are wrapped for its shell.
        const software = trace.attempt.server;
        const detectedPlatform = software ? (isWindowsServerSoftware(software) ? 'windows' : 'posix') : host.detectedPlatform;
        this.deps.store.patchHost(host.id, { lastConnectedAt: Date.now(), detectedPlatform });
        // Persist a freshly-entered password only now that it has actually worked.
        void plan.commit?.().catch(() => undefined);
        this.emit('change');
        resolve(client);
      });
      client.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(identTimer);
          pooled.closed = true;
          pooled.releaseJump?.();
          // The raw error goes to the classifier; dial() turns it into a
          // ConnectError and decides whether a saved password was stale.
          reject(err);
        } else {
          pooled.lastError = dropReason(err);
          this.emit('connection-error', host.id, friendlySshError(err));
        }
      });
      client.on('close', () => {
        // Closed by us (disconnect, idle timeout) or by the network/server?
        const dropped = !pooled.closed;
        if (!settled) {
          settled = true;
          clearTimeout(identTimer);
          reject(new Error('Connection closed during setup.'));
        } else {
          trace.ended(dropped ? 'dropped' : 'closed', dropped ? (pooled.lastError ?? dropReason(undefined)) : undefined);
        }
        if (this.pool.get(host.id) === pooled) this.pool.delete(host.id);
        if (!pooled.closed) {
          pooled.closed = true;
          pooled.releaseJump?.();
        }
        if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
        this.emit('closed', host.id);
        this.emit('change');
      });
      try {
        client.connect(config);
      } catch (err) {
        settled = true;
        clearTimeout(identTimer);
        pooled.closed = true;
        try {
          pooled.sock?.destroy();
        } catch {
          /* ignore */
        }
        pooled.releaseJump?.();
        reject(err);
      }
    });
  }

  private agentSocket(): string | undefined {
    if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
    const onePassword = join(homedir(), 'Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock');
    return existsSync(onePassword) ? onePassword : undefined;
  }

  /** Asks the user something during connect, recording the wait in the trace. */
  private async askDuringConnect<T>(trace: ConnTrace, pooled: Pooled, what: string, ask: (signal: AbortSignal) => Promise<T>, extra?: Record<string, string>): Promise<T> {
    trace.step('prompt', 'info', { what, ...extra });
    trace.promptPending = true;
    try {
      return await ask(pooled.abort.signal);
    } finally {
      trace.promptPending = false;
    }
  }

  private async buildAuth(host: Host, initiatedBy: Initiator, trace: ConnTrace, pooled: Pooled): Promise<AuthPlan> {
    const { vault, store, prompts } = this.deps;
    const username = host.username;
    switch (host.auth) {
      case 'agent': {
        const agent = this.agentSocket();
        if (!agent) throw new ConnPrepError('No SSH agent found (SSH_AUTH_SOCK is not set).', 'agent-missing');
        return { methods: [{ type: 'agent' as const, username, agent }] };
      }
      case 'password': {
        const saved = vault.unlocked ? vault.getHostPassword(host.id) : undefined;
        if (saved !== undefined) {
          // Using a stored password: if it fails, clear it so we prompt next time.
          return {
            methods: [{ type: 'password' as const, username, password: saved }],
            rollback: async () => {
              if (!vault.unlocked) return;
              await vault.setHostPassword(host.id, null);
              store.patchHost(host.id, { savePassword: false });
            },
          };
        }
        const res = await this.askDuringConnect(trace, pooled, 'password', (signal) =>
          prompts.ask({ kind: 'password', hostAlias: host.alias, username, host: host.hostname, initiatedBy }, undefined, signal),
        );
        if (!res || !('value' in res)) {
          trace.promptCancelled = true;
          throw new ConnPrepError('Password entry was cancelled.', 'cancelled');
        }
        const password = res.value;
        const plan: AuthPlan = { methods: [{ type: 'password' as const, username, password }] };
        if (res.save && vault.unlocked) {
          // Persist only after the login succeeds (connect() calls commit on 'ready').
          plan.commit = async () => {
            await vault.setHostPassword(host.id, password);
            store.patchHost(host.id, { savePassword: true });
          };
        }
        return plan;
      }
      case 'interactive':
        return { methods: [this.keyboardInteractive(host, initiatedBy, trace, pooled)] };
      case 'key':
      default: {
        if (!host.keyId) throw new ConnPrepError(`No SSH key is selected for "${host.alias}".`, 'key-missing');
        const info = store.getKey(host.keyId);
        if (!vault.unlocked) throw new ConnPrepError('Gatehouse is locked. Unlock it to use saved keys.', 'vault-locked');
        const pem = vault.getPrivateKey(host.keyId);
        if (!info || !pem) throw new ConnPrepError('The selected SSH key is missing. Choose another key.', 'key-missing');
        let passphrase = info.encrypted ? vault.getKeyPassphrase(info.id) : undefined;
        if (info.encrypted && passphrase === undefined) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const res = await this.askDuringConnect(trace, pooled, 'passphrase', (signal) => prompts.ask({ kind: 'passphrase', keyName: info.name, initiatedBy }, undefined, signal));
            if (!res || !('value' in res)) {
              trace.promptCancelled = true;
              throw new ConnPrepError('Passphrase entry was cancelled.', 'cancelled');
            }
            try {
              parsePrivateKey(pem, res.value);
              passphrase = res.value;
              if (res.save) {
                await vault.setKeyPassphrase(info.id, res.value);
                store.upsertKey({ ...info, savePassphrase: true });
              }
              break;
            } catch (err) {
              if (!(err instanceof KeyError) || err.code !== 'bad-passphrase') throw err;
              if (attempt === 2) throw new ConnPrepError(err.message, 'key-passphrase');
            }
          }
        }
        return { methods: [{ type: 'publickey' as const, username, key: pem, passphrase }] };
      }
    }
  }

  private keyboardInteractive(host: Host, initiatedBy: Initiator, trace: ConnTrace, pooled: Pooled): AnyAuthMethod {
    const { vault, prompts } = this.deps;
    return {
      type: 'keyboard-interactive',
      username: host.username,
      prompt: (name: string, instructions: string, _lang: string, list: { prompt: string; echo: boolean }[], reply: (answers: string[]) => void) => {
        // Answers that arrive after the attempt was cancelled are dropped:
        // the connection underneath is gone.
        const finish = (answers: string[]) => {
          if (pooled.closed) return;
          try {
            reply(answers);
          } catch {
            /* the connection is gone */
          }
        };
        const saved = host.auth === 'password' && vault.unlocked ? vault.getHostPassword(host.id) : undefined;
        if (list.length === 0) return finish([]);
        if (saved && list.every((p) => !p.echo && /password|passcode/i.test(p.prompt))) {
          return finish(list.map(() => saved));
        }
        this.askDuringConnect(
          trace,
          pooled,
          'keyboard-interactive',
          (signal) =>
            prompts.ask(
              {
                kind: 'keyboard-interactive',
                hostAlias: host.alias,
                name: name || '',
                instructions: instructions || '',
                prompts: list.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
                initiatedBy,
              },
              undefined,
              signal,
            ),
          // The questions the server asked (never the answers).
          { prompts: cleanServerText(list.map((p) => p.prompt.trim()).join(' / '), 120) },
        )
          .then((res) => {
            if (!res || !('answers' in res)) trace.promptCancelled = true;
            finish(res && 'answers' in res ? res.answers : []);
          })
          .catch(() => {
            trace.promptCancelled = true;
            finish([]);
          });
      },
    } as unknown as AnyAuthMethod;
  }

  private async verifyHostKey(host: Host, blob: Buffer, initiatedBy: Initiator, trace: ConnTrace, pooled: Pooled): Promise<boolean> {
    // ssh2 checks the host key again on every rekey, long after the attempt finished.
    const during = !trace.done;
    if (during) trace.stage = 'hostkey';
    const fingerprint = fingerprintBlob(blob);
    const keyType = blobKeyType(blob);
    const ok = await this.checkHostKey(host, blob, fingerprint, keyType, initiatedBy, trace, pooled);
    if (during && !trace.done) {
      if (!ok) trace.hostKeyRejected = true;
      trace.stage = 'kex';
    }
    return ok;
  }

  private async checkHostKey(host: Host, blob: Buffer, fingerprint: string, keyType: string, initiatedBy: Initiator, trace: ConnTrace, pooled: Pooled): Promise<boolean> {
    const { store, prompts } = this.deps;
    const b64 = blob.toString('base64');
    const known = store.findKnownHost(host.hostname, host.port);
    const pin = () => {
      const now = Date.now();
      store.upsertKnownHost({
        id: known?.id ?? randomUUID(),
        host: host.hostname,
        port: host.port,
        keyType,
        fingerprint,
        publicKey: b64,
        addedAt: now,
        lastSeenAt: now,
      });
    };
    const type = keyTypeLabel(keyType);
    if (known) {
      if (known.publicKey === b64) {
        store.touchKnownHost(known.id);
        trace.step('hostkey-known', 'ok', { type });
        return true;
      }
      const res = await this.askDuringConnect(trace, pooled, 'host-key', (signal) =>
        prompts.ask(
          {
            kind: 'host-key',
            hostAlias: host.alias,
            host: host.hostname,
            port: host.port,
            keyType,
            fingerprint,
            status: 'changed',
            previousFingerprint: known.fingerprint,
            initiatedBy,
          },
          undefined,
          signal,
        ),
      );
      if (res && 'accept' in res && res.accept) {
        pin();
        trace.step('hostkey-changed', 'ok', { fingerprint });
        return true;
      }
      trace.step('hostkey-rejected', 'fail', { fingerprint });
      return false;
    }
    const system = checkSystemKnownHosts(host.hostname, host.port, keyType, b64);
    if (system === 'match') {
      pin();
      trace.step('hostkey-system', 'ok', { type });
      return true;
    }
    if (system === 'revoked') {
      trace.step('hostkey-revoked', 'fail');
      return false;
    }
    const res = await this.askDuringConnect(trace, pooled, 'host-key', (signal) =>
      prompts.ask(
        {
          kind: 'host-key',
          hostAlias: host.alias,
          host: host.hostname,
          port: host.port,
          keyType,
          fingerprint,
          status: system === 'mismatch' ? 'changed' : 'unknown',
          initiatedBy,
        },
        undefined,
        signal,
      ),
    );
    if (res && 'accept' in res && res.accept) {
      pin();
      trace.step(system === 'mismatch' ? 'hostkey-changed' : 'hostkey-new', 'ok', { fingerprint });
      return true;
    }
    trace.step('hostkey-rejected', 'fail', { fingerprint });
    return false;
  }
}
