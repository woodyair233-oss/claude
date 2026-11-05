// Builds the real backend (store, SSH pool, SFTP, gateway, MCP socket) without
// Electron, so the whole AI → bridge → policy → SSH path can be tested in Node.

import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Host } from '../../../src/shared/types';
import { newHost } from '../../../src/shared/defaults';
import { Store } from '../../../src/main/store';
import type { Vault } from '../../../src/main/vault';
import { PromptBroker } from '../../../src/main/prompts';
import { ConnectionManager } from '../../../src/main/ssh/connection';
import { SftpManager } from '../../../src/main/ssh/sftp';
import { ForwardManager } from '../../../src/main/ssh/forwards';
import { TerminalManager } from '../../../src/main/ssh/terminal';
import { GatewayService } from '../../../src/main/gateway/service';
import { McpSocketServer } from '../../../src/main/gateway/socket-server';
import { keyInfoFromPrivate } from '../../../src/main/ssh/keys';
import type { TestSshd } from './sshd';

export const BRIDGE = resolve(__dirname, '../../../build/bin/linux-x64/gatehouse-mcp');

export function fakeVault(sshd: TestSshd, keys: Map<string, string>): Vault {
  return {
    unlocked: true,
    getHostPassword: () => sshd.password,
    getPrivateKey: (id: string) => keys.get(id),
    getKeyPassphrase: () => undefined,
    setHostPassword: async () => undefined,
    setKeyPassphrase: async () => undefined,
    setPrivateKey: async () => undefined,
    forgetHost: async () => undefined,
    savedPasswordHostIds: () => [],
    deriveKey: () => undefined,
    on: () => undefined,
    off: () => undefined,
    status: () => ({ state: 'unlocked', backend: 'basic', keychainWrap: false, passwordWrap: false, unrecoverable: false }),
  } as unknown as Vault;
}

export interface Harness {
  home: string;
  store: Store;
  prompts: PromptBroker;
  pool: ConnectionManager;
  sftp: SftpManager;
  forwards: ForwardManager;
  terminals: TerminalManager;
  gateway: GatewayService;
  keyId: string;
  addHost(partial: Partial<Host>): Host;
  connectClient(label?: string): Promise<{ client: Client; close: () => Promise<void> }>;
  close(): Promise<void>;
}

export async function startHarness(sshd: TestSshd): Promise<Harness> {
  const home = mkdtempSync('/tmp/gh-home-');
  const store = new Store(join(home, 'gatehouse.json'));
  const keys = new Map<string, string>();
  const vault = fakeVault(sshd, keys);
  const { info, privateKey } = keyInfoFromPrivate(sshd.keyPem, { name: 'test key', savePassphrase: false, source: 'imported' });
  keys.set(info.id, privateKey);
  store.upsertKey(info);
  store.upsertKnownHost({
    id: randomUUID(),
    host: sshd.host,
    port: sshd.port,
    keyType: sshd.hostKeyType,
    fingerprint: 'test',
    publicKey: sshd.hostKeyB64,
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
  });

  const prompts = new PromptBroker();
  const pool = new ConnectionManager({ store, vault, prompts });
  const sftp = new SftpManager(pool);
  const forwards = new ForwardManager(pool);
  const terminalData = new Map<string, Buffer[]>();
  const terminals = new TerminalManager(pool, {
    data: (id, data) => {
      const list = terminalData.get(id) ?? [];
      list.push(Buffer.from(data));
      terminalData.set(id, list);
    },
  });
  (terminals as unknown as { output: Map<string, Buffer[]> }).output = terminalData;
  const gateway = new GatewayService({
    store,
    vault,
    pool,
    sftp,
    touchId: { available: () => false, prompt: async () => true },
    appVersion: '1.0.0-test',
    auditDir: join(home, 'audit'),
    bridgePath: () => BRIDGE,
    bridgeExists: () => true,
  });
  await gateway.init();
  const socket = new McpSocketServer(gateway, {
    socketPath: join(home, 'run', 'mcp.sock'),
    endpointPath: join(home, 'run', 'endpoint.json'),
    appVersion: '1.0.0-test',
  });
  await socket.start();

  const clients: { close: () => Promise<void> }[] = [];
  const h: Harness = {
    home,
    store,
    prompts,
    pool,
    sftp,
    forwards,
    terminals,
    gateway,
    keyId: info.id,
    addHost(partial) {
      const host = newHost({
        id: randomUUID(),
        alias: 'test',
        hostname: sshd.host,
        port: sshd.port,
        username: sshd.user,
        auth: 'key',
        keyId: info.id,
        ...partial,
      });
      store.upsertHost(host);
      return host;
    },
    async connectClient(label) {
      const transport = new StdioClientTransport({
        command: BRIDGE,
        args: ['--no-launch', ...(label ? ['--label', label] : [])],
        env: { GATEHOUSE_HOME: home, PATH: process.env.PATH ?? '' },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'gatehouse-integration-test', version: '1.0.0' });
      await client.connect(transport);
      const entry = { close: () => client.close() };
      clients.push(entry);
      return { client, close: entry.close };
    },
    async close() {
      for (const c of clients) await c.close().catch(() => undefined);
      socket.stop();
      forwards.stopAll();
      terminals.closeAll();
      pool.disconnectAll();
      await gateway.audit.flush();
      await store.flush();
    },
  };
  return h;
}

export function toolText(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  return (r.content ?? []).map((c) => c.text ?? '').join('\n');
}
