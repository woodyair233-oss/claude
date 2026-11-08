// Connection diagnostics against a real OpenSSH server: each way a connection
// can fail must end up with the right cause, a useful timeline, and no secrets.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnAttempt, Host } from '../../src/shared/types';
import { newHost } from '../../src/shared/defaults';
import { Store } from '../../src/main/store';
import type { Vault } from '../../src/main/vault';
import { PromptBroker } from '../../src/main/prompts';
import { ConnectionManager } from '../../src/main/ssh/connection';
import { ConnLog, isConnectError } from '../../src/main/ssh/diagnostics';
import { generateKey, keyInfoFromPrivate } from '../../src/main/ssh/keys';
import { SSHD_AVAILABLE, startSshd, type TestSshd } from './helpers/sshd';

const d = SSHD_AVAILABLE ? describe : describe.skip;

interface Rig {
  store: Store;
  prompts: PromptBroker;
  pool: ConnectionManager;
  log: ConnLog;
  logPath: string;
  passwords: Map<string, string>;
  keys: Map<string, string>;
  keyId: string;
  addHost(sshd: TestSshd, partial: Partial<Host>): Host;
}

/** `keyPem` must be the key currently in the test user's authorized_keys (the last sshd started wrote it). */
function makeRig(sshd: TestSshd, keyPem: string): Rig {
  const home = mkdtempSync('/tmp/gh-diag-');
  const store = new Store(join(home, 'gatehouse.json'));
  const passwords = new Map<string, string>();
  const keys = new Map<string, string>();
  const vault = {
    unlocked: true,
    getHostPassword: (id: string) => passwords.get(id),
    getPrivateKey: (id: string) => keys.get(id),
    getKeyPassphrase: () => undefined,
    setHostPassword: async (id: string, pw: string | null) => {
      if (pw === null) passwords.delete(id);
      else passwords.set(id, pw);
    },
    setKeyPassphrase: async () => undefined,
    savedPasswordHostIds: () => [...passwords.keys()],
  } as unknown as Vault;
  const { info, privateKey } = keyInfoFromPrivate(keyPem, { name: 'test key', savePassphrase: false, source: 'imported' });
  keys.set(info.id, privateKey);
  store.upsertKey(info);
  const pin = (s: TestSshd) =>
    store.upsertKnownHost({ id: randomUUID(), host: s.host, port: s.port, keyType: s.hostKeyType, fingerprint: 'test', publicKey: s.hostKeyB64, addedAt: 0, lastSeenAt: 0 });
  pin(sshd);
  const prompts = new PromptBroker();
  const logPath = join(home, 'connections.json');
  const log = new ConnLog(logPath);
  const pool = new ConnectionManager({ store, vault, prompts, connLog: log, timeouts: { identMs: 1500, probeMs: 700, tcpMs: 5000 } });
  return {
    store,
    prompts,
    pool,
    log,
    logPath,
    passwords,
    keys,
    keyId: info.id,
    addHost(target, partial) {
      if (!store.findKnownHost(target.host, target.port)) pin(target);
      const host = newHost({
        id: randomUUID(),
        alias: `h-${randomUUID().slice(0, 6)}`,
        hostname: target.host,
        port: target.port,
        username: target.user,
        auth: 'key',
        keyId: info.id,
        ...partial,
      });
      store.upsertHost(host);
      return host;
    },
  };
}

/** Connects and returns the recorded attempt (and the thrown error, if any). */
async function attempt(rig: Rig, host: Host): Promise<{ a: ConnAttempt; err?: unknown }> {
  let err: unknown;
  try {
    const lease = await rig.pool.acquire(host.id, 'user');
    lease.release();
    rig.pool.disconnect(host.id);
  } catch (e) {
    err = e;
  }
  const latest = rig.log.latest(host.id);
  expect(latest).toBeTruthy();
  return { a: rig.log.get(latest!.id)!, err };
}

const codes = (a: ConnAttempt) => a.steps.map((s) => s.code);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('connection diagnostics (real sshd)', () => {
  let sshd: TestSshd;
  let keyOnly: TestSshd;
  let maxTries: TestSshd;
  let twoStep: TestSshd;
  let rig: Rig;
  const servers: net.Server[] = [];

  beforeAll(async () => {
    sshd = await startSshd();
    keyOnly = await startSshd({ PasswordAuthentication: 'no' });
    maxTries = await startSshd({ MaxAuthTries: '1' });
    twoStep = await startSshd({ AuthenticationMethods: 'publickey,password' });
    // All servers share the test user, so its authorized_keys holds the last one's client key.
    rig = makeRig(sshd, twoStep.keyPem);
  });

  afterAll(() => {
    rig?.pool.disconnectAll();
    for (const s of servers) s.close();
    for (const x of [sshd, keyOnly, maxTries, twoStep]) x?.stop();
  });

  it('records every step of a successful connection', async () => {
    const host = rig.addHost(sshd, {});
    const { a, err } = await attempt(rig, host);
    expect(err).toBeUndefined();
    expect(a.outcome).toBe('connected');
    expect(codes(a)).toEqual(expect.arrayContaining(['tcp-ok', 'ident', 'kex-ok', 'hostkey-known', 'auth-methods', 'auth-try', 'auth-ok', 'ready']));
    expect(String(a.steps.find((x) => x.code === 'auth-methods')?.params?.allowed)).toContain('publickey');
    expect(a.server).toMatch(/OpenSSH/);
    // The protocol log is only kept to explain failures.
    expect(a.log).toBeUndefined();
    expect(rig.log.statuses()[host.id]).toMatchObject({ outcome: 'connected' });
  });

  it('explains a wrong password, and never records it', async () => {
    const host = rig.addHost(sshd, { auth: 'password' });
    rig.passwords.set(host.id, 'Not-The-Password-42');
    const { a, err } = await attempt(rig, host);
    expect(isConnectError(err)).toBe(true);
    expect(a.cause).toBe('auth-password');
    const fail = a.steps.find((s) => s.code === 'auth-fail');
    expect(String(fail?.params?.allowed)).toContain('password');
    // A refused saved password is cleared so the next attempt asks again.
    expect(rig.passwords.has(host.id)).toBe(false);
    expect(JSON.stringify(a)).not.toContain('Not-The-Password-42');
    rig.log.flushSync();
    expect(readFileSync(rig.logPath, 'utf8')).not.toContain('Not-The-Password-42');
    expect(a.log?.some((l) => l.includes('USERAUTH_FAILURE'))).toBe(true);
  });

  it('says when the server does not allow password logins at all', async () => {
    const host = rig.addHost(keyOnly, { auth: 'password' });
    rig.passwords.set(host.id, keyOnly.password);
    const { a } = await attempt(rig, host);
    expect(a.cause).toBe('auth-method');
    expect(a.causeParams).toMatchObject({ method: 'password' });
    expect(String(a.causeParams?.allowed)).toContain('publickey');
    expect(String(a.causeParams?.allowed)).not.toContain('password');
  });

  it('explains a key the server does not know', async () => {
    const other = generateKey({ name: 'stranger', type: 'ed25519', comment: 'stranger', savePassphrase: false });
    rig.keys.set(other.info.id, other.privateKey);
    rig.store.upsertKey(other.info);
    const host = rig.addHost(sshd, { keyId: other.info.id });
    const { a } = await attempt(rig, host);
    expect(a.cause).toBe('auth-key');
    expect(JSON.stringify(a)).not.toContain('PRIVATE KEY');
  });

  it('explains a closed port', async () => {
    const host = rig.addHost(sshd, { port: await freePort() });
    const { a, err } = await attempt(rig, host);
    expect(a.cause).toBe('refused');
    expect(a.steps.find((s) => s.code === 'tcp-fail')?.params?.code).toBe('ECONNREFUSED');
    // What Claude would be told: no address.
    expect((err as Error).message).toMatch(/refused the connection on port \d+/);
    expect((err as Error).message).not.toContain('127.0.0.1');
  });

  it('explains a name that does not exist', async () => {
    const host = rig.addHost(sshd, { hostname: 'no-such-host.invalid' });
    const { a } = await attempt(rig, host);
    expect(a.cause).toBe('dns');
    expect(codes(a)).toContain('dns-fail');
  });

  it('recognises a port that runs a different service', async () => {
    // Answers like a web server: nothing until the client speaks, then an HTTP error.
    const srv = net.createServer((sock) => {
      sock.on('error', () => undefined);
      sock.once('data', () => sock.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'));
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const host = rig.addHost(sshd, { port: (srv.address() as net.AddressInfo).port });
    const { a } = await attempt(rig, host);
    expect(a.cause).toBe('not-ssh');
    expect(String(a.steps.find((s) => s.code === 'probe-text')?.params?.banner)).toContain('HTTP/1.1 400');
  });

  it('recognises a port that accepts connections but never answers', async () => {
    const srv = net.createServer((sock) => sock.on('error', () => undefined));
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const host = rig.addHost(sshd, { port: (srv.address() as net.AddressInfo).port });
    const { a } = await attempt(rig, host);
    expect(codes(a)).toContain('ident-timeout');
    expect(a.cause).toBe('no-greeting');
  });

  it('records a rejected server identity', async () => {
    const host = rig.addHost(sshd, { hostname: 'localhost' });
    rig.store.upsertKnownHost({
      id: randomUUID(),
      host: 'localhost',
      port: sshd.port,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:old',
      publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIOldOldOldOldOldOldOldOldOldOldOldOldOldOldOld',
      addedAt: 0,
      lastSeenAt: 0,
    });
    const deny = (req: { id: string }) => rig.prompts.respond(req.id, { accept: false });
    rig.prompts.on('ask', deny);
    const { a } = await attempt(rig, host);
    rig.prompts.off('ask', deny);
    expect(a.cause).toBe('hostkey-rejected');
    expect(codes(a)).toEqual(expect.arrayContaining(['prompt', 'hostkey-rejected']));
  });

  it('records a cancelled password prompt', async () => {
    const host = rig.addHost(sshd, { auth: 'password' });
    const cancel = (req: { id: string }) => rig.prompts.respond(req.id, null);
    rig.prompts.on('ask', cancel);
    const { a } = await attempt(rig, host);
    rig.prompts.off('ask', cancel);
    expect(a.cause).toBe('cancelled');
    expect(a.steps[0]).toMatchObject({ code: 'prompt', params: { what: 'password' } });
  });

  it('separates a failing jump host from a jump host that cannot reach the target', async () => {
    const jump = rig.addHost(sshd, { alias: 'jumpbox' });
    const target = rig.addHost(sshd, { jumpHostId: jump.id, port: await freePort() });
    const { a } = await attempt(rig, target);
    expect(a.via).toBe('jumpbox');
    expect(a.cause).toBe('jump-forward');
    expect(codes(a)).toEqual(expect.arrayContaining(['jump-ok', 'tunnel-fail']));

    const badJump = rig.addHost(sshd, { alias: 'badjump', port: await freePort() });
    const target2 = rig.addHost(sshd, { jumpHostId: badJump.id });
    const r2 = await attempt(rig, target2);
    expect(r2.a.cause).toBe('jump');
    expect(r2.a.via).toBe('badjump');
    // What Claude is told does not name the jump host (it may be hidden from Claude).
    expect((r2.err as Error).message).not.toContain('badjump');
    // The jump host's own attempt explains why it failed.
    expect(rig.log.latest(badJump.id)?.cause).toBe('refused');
  });

  it('reports a cancel while the server-identity question is open, without a second check', async () => {
    const host = rig.addHost(sshd, { hostname: 'localhost' });
    rig.store.upsertKnownHost({
      id: randomUUID(),
      host: 'localhost',
      port: sshd.port,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:other',
      publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOtherOther',
      addedAt: 0,
      lastSeenAt: 0,
    });
    const asked: string[] = [];
    const onAsk = (req: { id: string }) => {
      asked.push(req.id);
      rig.pool.disconnect(host.id);
    };
    rig.prompts.on('ask', onAsk);
    const started = Date.now();
    const { a, err } = await attempt(rig, host);
    rig.prompts.off('ask', onAsk);
    for (const id of asked) rig.prompts.respond(id, { accept: false });
    expect(asked).toHaveLength(1);
    expect(a.cause).toBe('cancelled');
    expect((err as Error).message).toBe('The connection was cancelled');
    expect(codes(a).some((c) => c.startsWith('probe-'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops at once when a connection to a silent port is cancelled', async () => {
    const srv = net.createServer((sock) => sock.on('error', () => undefined));
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const host = rig.addHost(sshd, { port: (srv.address() as net.AddressInfo).port });
    const pending = rig.pool.acquire(host.id, 'user').catch((e: unknown) => e);
    await sleep(300);
    const t0 = Date.now();
    rig.pool.disconnect(host.id);
    const err = (await pending) as { connCause?: string };
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(err.connCause).toBe('cancelled');
    const a = rig.log.get(rig.log.latest(host.id)!.id)!;
    expect(codes(a).some((c) => c.startsWith('probe-'))).toBe(false);
  });

  it('clears a saved password the server refused, also when the server disconnects on failure', async () => {
    const host = rig.addHost(maxTries, { auth: 'password' });
    rig.passwords.set(host.id, 'Wrong-Again-1');
    const { a } = await attempt(rig, host);
    expect(a.cause).toBe('auth-password');
    expect(rig.passwords.has(host.id)).toBe(false);
  });

  it('recognises a two-step login whose first step passed', async () => {
    const host = rig.addHost(twoStep, {});
    const { a } = await attempt(rig, host);
    expect(a.cause).toBe('auth-partial');
    expect(String(a.causeParams?.allowed)).toContain('password');
    expect(codes(a)).toContain('auth-partial');
  });

  it('tells a missing SSH agent from an empty one', async () => {
    const before = process.env.SSH_AUTH_SOCK;
    const host = rig.addHost(sshd, { auth: 'agent' });
    try {
      process.env.SSH_AUTH_SOCK = `/tmp/gh-no-such-agent-${process.pid}.sock`;
      expect((await attempt(rig, host)).a.cause).toBe('agent-missing');

      const sock = `/tmp/gh-agent-${process.pid}.sock`;
      const agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
      try {
        for (let i = 0; i < 50 && !existsSync(sock); i++) await sleep(100);
        process.env.SSH_AUTH_SOCK = sock;
        const { a } = await attempt(rig, host);
        expect(a.cause).toBe('agent-empty');
        expect(codes(a)).toContain('agent-empty');
      } finally {
        agent.kill();
      }
    } finally {
      if (before === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = before;
    }
  });

  it('marks a connection that drops after it was established', async () => {
    const host = rig.addHost(sshd, {});
    const lease = await rig.pool.acquire(host.id, 'user');
    const closed = new Promise<void>((r) => rig.pool.once('closed', () => r()));
    // Simulate the network going away underneath the SSH connection.
    (lease.client as unknown as { _sock: net.Socket })._sock.destroy();
    await closed;
    lease.release();
    const a = rig.log.get(lease.attemptId)!;
    expect(a.outcome).toBe('connected');
    expect(a.endCause).toBe('dropped');
    expect(rig.log.statuses()[host.id]).toMatchObject({ dropped: true });
  });

  it('records when a connection ended, even when everything is closed at once (quit)', async () => {
    const host = rig.addHost(sshd, {});
    const lease = await rig.pool.acquire(host.id, 'user');
    lease.release();
    await sleep(1100);
    rig.pool.disconnectAll();
    const a = rig.log.get(lease.attemptId)!;
    expect(a.endCause).toBe('closed');
    expect(a.endedAt! - a.startedAt).toBeGreaterThanOrEqual(1000);
  });

  it('keeps the log across restarts', () => {
    rig.log.flushSync();
    const reloaded = new ConnLog(rig.logPath);
    const all = reloaded.list();
    expect(all.length).toBeGreaterThan(5);
    expect(all.every((x) => x.outcome !== 'connecting')).toBe(true);
    expect(JSON.stringify(reloaded.list())).not.toContain(sshd.password);
  });
});
