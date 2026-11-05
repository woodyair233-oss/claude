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
// ssh2 keeps its algorithm tables here; used to drop names this runtime cannot use.
import constants from 'ssh2/lib/protocol/constants.js';


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
}

export interface Lease {
  client: ClientType;
  host: Host;
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
}

export class ConnectionManager extends EventEmitter {
  private pool = new Map<string, Pooled>();

  constructor(private readonly deps: ConnectionDeps) {
    super();
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
    const pooled: Pooled = { hostId: host.id, client, refs: 0, closed: false, ready: Promise.resolve(client) };
    pooled.ready = this.connect(host, client, pooled, initiatedBy, chain);
    pooled.ready.catch(() => undefined);
    return pooled;
  }

  private async connect(host: Host, client: ClientType, pooled: Pooled, initiatedBy: Initiator, chain: string[]): Promise<ClientType> {
    if (chain.includes(host.id)) throw new Error('Jump host loop detected.');
    if (chain.length > MAX_JUMP_DEPTH) throw new Error('Too many chained jump hosts.');

    // Build auth first: a cancelled prompt, locked vault or missing key must not
    // leak the jump-host lease and its forwarded channel.
    const plan = await this.buildAuth(host, initiatedBy);
    if (pooled.closed) throw new Error('Connection was cancelled.');
    const authQueue = [...plan.methods];
    let triedInteractive = host.auth === 'interactive';

    let sock: NodeJS.ReadableStream | undefined;
    if (host.jumpHostId) {
      const jump = await this.acquire(host.jumpHostId, initiatedBy, [...chain, host.id]);
      pooled.releaseJump = jump.release;
      if (pooled.closed) {
        jump.release();
        pooled.releaseJump = undefined;
        throw new Error('Connection was cancelled.');
      }
      try {
        sock = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
          jump.client.forwardOut('127.0.0.1', 0, host.hostname, host.port, (err, stream) => {
            if (err) return reject(new Error(`Jump host could not reach ${host.alias}: ${err.message}`));
            try {
              assertSaneChannel(stream);
            } catch (e) {
              return reject(e);
            }
            resolve(stream);
          }),
        );
      } catch (err) {
        jump.release();
        pooled.releaseJump = undefined;
        throw err;
      }
    }

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
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        this.verifyHostKey(host, key, initiatedBy).then(verify, () => verify(false));
      },
      authHandler: ((methodsLeft: string[] | null, _partial: boolean, next: (m: AnyAuthMethod | false) => void) => {
        const method = authQueue.shift();
        if (method) return next(method);
        if (!triedInteractive && (methodsLeft ?? []).includes('keyboard-interactive')) {
          triedInteractive = true;
          return next(this.keyboardInteractive(host, initiatedBy));
        }
        return next(false);
      }) as unknown as ConnectConfig['authHandler'],
    };
    if (sock) config.sock = sock as ConnectConfig['sock'];

    return new Promise<ClientType>((resolve, reject) => {
      let settled = false;
      client.once('ready', () => {
        settled = true;
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
        this.deps.store.patchHost(host.id, { lastConnectedAt: Date.now() });
        // Persist a freshly-entered password only now that it has actually worked.
        void plan.commit?.().catch(() => undefined);
        this.emit('change');
        resolve(client);
      });
      client.on('error', (err) => {
        if (!settled) {
          settled = true;
          pooled.closed = true;
          pooled.releaseJump?.();
          // A saved password that just failed is stale: clear it so the next
          // attempt prompts again instead of silently reusing it.
          void plan.rollback?.().catch(() => undefined);
          reject(new Error(friendlySshError(err)));
        } else {
          this.emit('connection-error', host.id, friendlySshError(err));
        }
      });
      client.on('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('Connection closed during setup.'));
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
        reject(new Error(friendlySshError(err)));
      }
    });
  }

  private agentSocket(): string | undefined {
    if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
    const onePassword = join(homedir(), 'Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock');
    return existsSync(onePassword) ? onePassword : undefined;
  }

  private async buildAuth(host: Host, initiatedBy: Initiator): Promise<AuthPlan> {
    const { vault, store, prompts } = this.deps;
    const username = host.username;
    switch (host.auth) {
      case 'agent': {
        const agent = this.agentSocket();
        if (!agent) throw new Error('No SSH agent found (SSH_AUTH_SOCK is not set).');
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
        const res = await prompts.ask({ kind: 'password', hostAlias: host.alias, username, host: host.hostname, initiatedBy });
        if (!res || !('value' in res)) throw new Error('Password entry was cancelled.');
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
        return { methods: [this.keyboardInteractive(host, initiatedBy)] };
      case 'key':
      default: {
        if (!host.keyId) throw new Error(`No SSH key is selected for "${host.alias}".`);
        const info = store.getKey(host.keyId);
        if (!vault.unlocked) throw new Error('Gatehouse is locked. Unlock it to use saved keys.');
        const pem = vault.getPrivateKey(host.keyId);
        if (!info || !pem) throw new Error('The selected SSH key is missing. Choose another key.');
        let passphrase = info.encrypted ? vault.getKeyPassphrase(info.id) : undefined;
        if (info.encrypted && passphrase === undefined) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const res = await prompts.ask({ kind: 'passphrase', keyName: info.name, initiatedBy });
            if (!res || !('value' in res)) throw new Error('Passphrase entry was cancelled.');
            try {
              parsePrivateKey(pem, res.value);
              passphrase = res.value;
              if (res.save) {
                await vault.setKeyPassphrase(info.id, res.value);
                store.upsertKey({ ...info, savePassphrase: true });
              }
              break;
            } catch (err) {
              if (!(err instanceof KeyError) || err.code !== 'bad-passphrase' || attempt === 2) throw err;
            }
          }
        }
        return { methods: [{ type: 'publickey' as const, username, key: pem, passphrase }] };
      }
    }
  }

  private keyboardInteractive(host: Host, initiatedBy: Initiator): AnyAuthMethod {
    const { vault, prompts } = this.deps;
    return {
      type: 'keyboard-interactive',
      username: host.username,
      prompt: (name: string, instructions: string, _lang: string, list: { prompt: string; echo: boolean }[], finish: (answers: string[]) => void) => {
        const saved = host.auth === 'password' && vault.unlocked ? vault.getHostPassword(host.id) : undefined;
        if (list.length === 0) return finish([]);
        if (saved && list.every((p) => !p.echo && /password|passcode/i.test(p.prompt))) {
          return finish(list.map(() => saved));
        }
        prompts
          .ask({
            kind: 'keyboard-interactive',
            hostAlias: host.alias,
            name: name || '',
            instructions: instructions || '',
            prompts: list.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
            initiatedBy,
          })
          .then((res) => finish(res && 'answers' in res ? res.answers : []))
          .catch(() => finish([]));
      },
    } as unknown as AnyAuthMethod;
  }

  private async verifyHostKey(host: Host, blob: Buffer, initiatedBy: Initiator): Promise<boolean> {
    const { store, prompts } = this.deps;
    const fingerprint = fingerprintBlob(blob);
    const keyType = blobKeyType(blob);
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
    if (known) {
      if (known.publicKey === b64) {
        store.touchKnownHost(known.id);
        return true;
      }
      const res = await prompts.ask({
        kind: 'host-key',
        hostAlias: host.alias,
        host: host.hostname,
        port: host.port,
        keyType,
        fingerprint,
        status: 'changed',
        previousFingerprint: known.fingerprint,
        initiatedBy,
      });
      if (res && 'accept' in res && res.accept) {
        pin();
        return true;
      }
      return false;
    }
    const system = checkSystemKnownHosts(host.hostname, host.port, keyType, b64);
    if (system === 'match') {
      pin();
      return true;
    }
    if (system === 'revoked') return false;
    const res = await prompts.ask({
      kind: 'host-key',
      hostAlias: host.alias,
      host: host.hostname,
      port: host.port,
      keyType,
      fingerprint,
      status: system === 'mismatch' ? 'changed' : 'unknown',
      initiatedBy,
    });
    if (res && 'accept' in res && res.accept) {
      pin();
      return true;
    }
    return false;
  }
}
