import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execCommand } from '../../src/main/ssh/exec';
import { SSHD_AVAILABLE, startSshd, type TestSshd } from './helpers/sshd';
import { startHarness, toolText, type Harness } from './helpers/harness';
import type { ApprovalRequest } from '../../src/shared/types';

const d = SSHD_AVAILABLE ? describe : describe.skip;

d('SSH engine and MCP gateway (real sshd)', () => {
  let sshd: TestSshd;
  let h: Harness;

  beforeAll(async () => {
    sshd = await startSshd();
    h = await startHarness(sshd);
  });

  afterAll(async () => {
    await h?.close();
    sshd?.stop();
  });

  // ---------------------------------------------------------------- SSH engine
  it('connects with a key and runs a command (bash wrapper, exit codes)', async () => {
    const host = h.addHost({ alias: 'engine' });
    const lease = await h.pool.acquire(host.id, 'user');
    try {
      const r = await execCommand(lease.client, 'echo "hello $(whoami)"; echo oops >&2; exit 3', { timeoutMs: 10_000 });
      expect(r.stdout.trim()).toBe(`hello ${sshd.user}`);
      expect(r.stderr.trim()).toBe('oops');
      expect(r.exitCode).toBe(3);
    } finally {
      lease.release();
    }
  });

  it('times out long commands and kills them', async () => {
    const host = h.store.findHostByAlias('engine')!;
    const lease = await h.pool.acquire(host.id, 'user');
    try {
      const r = await execCommand(lease.client, 'sleep 30', { timeoutMs: 800 });
      expect(r.timedOut).toBe(true);
      expect(r.durationMs).toBeLessThan(8000);
    } finally {
      lease.release();
    }
  });

  it('authenticates with a password', async () => {
    const host = h.addHost({ alias: 'pw', auth: 'password' });
    const lease = await h.pool.acquire(host.id, 'user');
    const r = await execCommand(lease.client, 'whoami', { timeoutMs: 10_000 });
    lease.release();
    expect(r.stdout.trim()).toBe(sshd.user);
  });

  it('rejects a changed host key unless the user accepts', async () => {
    const host = h.addHost({ alias: 'mitm', hostname: 'localhost' });
    h.store.upsertKnownHost({
      id: 'fake',
      host: 'localhost',
      port: sshd.port,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:fake',
      publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake',
      addedAt: 0,
      lastSeenAt: 0,
    });
    const seen: string[] = [];
    const listener = (req: { id: string; kind: string; status?: string }) => {
      seen.push(`${req.kind}:${req.status}`);
      h.prompts.respond(req.id, { accept: false });
    };
    h.prompts.on('ask', listener);
    await expect(h.pool.acquire(host.id, 'user')).rejects.toThrow();
    h.prompts.off('ask', listener);
    expect(seen).toContain('host-key:changed');
  });

  it('connects through a jump host', async () => {
    const jump = h.store.findHostByAlias('engine')!;
    const target = h.addHost({ alias: 'behind-jump', jumpHostId: jump.id });
    const lease = await h.pool.acquire(target.id, 'user');
    const r = await execCommand(lease.client, 'echo via-jump', { timeoutMs: 10_000 });
    lease.release();
    expect(r.stdout.trim()).toBe('via-jump');
  });

  it('opens an interactive terminal', async () => {
    const host = h.store.findHostByAlias('engine')!;
    const id = h.terminals.open(host.id, 'test', 100, 30);
    const output = (h.terminals as unknown as { output: Map<string, Buffer[]> }).output;
    const deadline = Date.now() + 10_000;
    while (h.terminals.list().find((t) => t.id === id)?.state !== 'connected' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    h.terminals.write(id, 'echo TERMINAL_$((40+2))\n');
    let text = '';
    while (!text.includes('TERMINAL_42') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      text = Buffer.concat(output.get(id) ?? []).toString();
    }
    expect(text).toContain('TERMINAL_42');
    h.terminals.close(id);
  });

  it('lists, writes, reads and transfers files over SFTP', async () => {
    const host = h.store.findHostByAlias('engine')!;
    const home = await h.sftp.home(host.id);
    expect(home).toBe(`/home/${sshd.user}`);
    await h.sftp.writeFile(host.id, `${home}/gh-sftp.txt`, Buffer.from('line1\nline2\n'), { initiatedBy: 'user' });
    const r = await h.sftp.readFile(host.id, `${home}/gh-sftp.txt`, { maxBytes: 1000, initiatedBy: 'user' });
    expect(r.data.toString()).toBe('line1\nline2\n');
    const { entries } = await h.sftp.list(host.id, home);
    expect(entries.find((e) => e.name === 'gh-sftp.txt')?.type).toBe('file');
    expect(entries.find((e) => e.name === '.ssh')?.type).toBe('dir');

    const local = mkdtempSync('/tmp/gh-xfer-');
    writeFileSync(join(local, 'up.bin'), Buffer.alloc(300_000, 7));
    await h.sftp.upload(host.id, [join(local, 'up.bin')], home);
    await h.sftp.download(host.id, [`${home}/up.bin`], join(local, 'dl'));
    expect(readFileSync(join(local, 'dl', 'up.bin')).length).toBe(300_000);
    expect(h.sftp.listTransfers().every((t) => t.state === 'done')).toBe(true);
    await h.sftp.remove(host.id, [`${home}/up.bin`, `${home}/gh-sftp.txt`]);
  });

  it('forwards a local port and serves SOCKS5', async () => {
    const host = h.store.findHostByAlias('engine')!;
    const local = { id: 'fwd-local', name: 'l', hostId: host.id, type: 'local' as const, bindAddress: '127.0.0.1', bindPort: 18022, destHost: '127.0.0.1', destPort: sshd.port, autoStart: false };
    await h.forwards.start(local);
    const banner = await new Promise<string>((resolve, reject) => {
      const s = net.connect(18022, '127.0.0.1');
      s.once('data', (d) => {
        resolve(d.toString());
        s.destroy();
      });
      s.once('error', reject);
    });
    expect(banner).toMatch(/^SSH-2\.0-OpenSSH/);
    h.forwards.stop('fwd-local');

    const socks = { ...local, id: 'fwd-socks', type: 'dynamic' as const, bindPort: 18023, destHost: '', destPort: 0 };
    await h.forwards.start(socks);
    const viaSocks = await new Promise<string>((resolve, reject) => {
      const s = net.connect(18023, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])));
      let stage = 0;
      s.on('data', (d) => {
        if (stage === 0) {
          stage = 1;
          const req = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, (sshd.port >> 8) & 0xff, sshd.port & 0xff]);
          s.write(req);
        } else if (stage === 1) {
          stage = 2;
          if (d[1] !== 0) return reject(new Error('socks failure'));
          if (d.length > 10) {
            resolve(d.subarray(10).toString());
            s.destroy();
          }
        } else {
          resolve(d.toString());
          s.destroy();
        }
      });
      s.once('error', reject);
    });
    expect(viaSocks).toMatch(/^SSH-2\.0-OpenSSH/);
    h.forwards.stop('fwd-socks');
  });

  // ---------------------------------------------------------------- MCP gateway
  it('exposes tools over the bridge and hides connection details', async () => {
    h.addHost({ alias: 'web', ai: { mode: 'ask', fileWrite: 'ask', allowPatterns: [], denyPatterns: [], requireTouchId: false, description: 'Lab web server' } });
    h.addHost({ alias: 'secret-box', ai: { mode: 'off', fileWrite: 'deny', allowPatterns: [], denyPatterns: [], requireTouchId: false, description: '' } });
    const { client } = await h.connectClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ['get_host_info', 'list_directory', 'list_hosts', 'list_snippets', 'read_file', 'run_command', 'run_snippet', 'write_file'].sort(),
    );
    const list = toolText(await client.callTool({ name: 'list_hosts', arguments: {} }));
    expect(list).toContain('web');
    expect(list).toContain('Lab web server');
    expect(list).not.toContain('secret-box');
    expect(list).not.toContain('127.0.0.1');
    expect(list).not.toContain(sshd.user);
  });

  it('auto-approves read-only commands and redacts identities and IPs', async () => {
    const { client } = await h.connectClient();
    const out = toolText(await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'whoami; echo 10.20.30.40 192.168.7.8' } }));
    expect(out).toContain('auto-approved');
    expect(out).not.toContain(sshd.user);
    expect(out).toContain('[user:web]');
    expect(out).toMatch(/\[ip-\d+\] \[ip-\d+\]/);
    expect(out).not.toContain('10.20.30.40');
  });

  it('substitutes placeholders the AI copies back into commands', async () => {
    const { client } = await h.connectClient();
    const first = toolText(await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'echo 172.16.5.9' } }));
    const token = first.match(/\[ip-\d+\]/)![0];
    const second = toolText(await client.callTool({ name: 'run_command', arguments: { host: 'web', command: `echo ${token} | tr . -` } }));
    expect(second).toContain('172-16-5-9');
  });

  it('asks the human for state-changing commands and runs them once approved', async () => {
    const { client } = await h.connectClient();
    const seen: ApprovalRequest[] = [];
    const onReq = (req: ApprovalRequest) => {
      seen.push(req);
      void h.gateway.approvals.decide(req.id, { action: 'allow', scope: 'once' });
    };
    h.gateway.approvals.on('request', onReq);
    const out = toolText(
      await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'touch /tmp/gh-approved && echo made', reason: 'test approval' } }),
    );
    h.gateway.approvals.off('request', onReq);
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe('test approval');
    expect(seen[0].assessment?.risk).toBe('write');
    expect(seen[0].cause).toBe('mode-ask');
    expect(out).toContain('approved by the user');
    expect(out).toContain('made');
  });

  it('runs the command the human edited instead of the original', async () => {
    const { client } = await h.connectClient();
    const onReq = (req: ApprovalRequest) =>
      void h.gateway.approvals.decide(req.id, { action: 'allow', scope: 'once', editedCommand: 'echo edited-by-human' });
    h.gateway.approvals.on('request', onReq);
    const out = toolText(await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'touch /tmp/should-not-exist' } }));
    h.gateway.approvals.off('request', onReq);
    expect(out).toContain('edited-by-human');
    expect(out).toContain('the user edited the command');
  });

  it('returns the human denial message to the AI', async () => {
    const { client } = await h.connectClient();
    const onReq = (req: ApprovalRequest) => void h.gateway.approvals.decide(req.id, { action: 'deny', message: 'check the logs first' });
    h.gateway.approvals.on('request', onReq);
    const res = await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'systemctl restart nginx' } });
    h.gateway.approvals.off('request', onReq);
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('check the logs first');
    expect(toolText(res)).toContain('Do not retry');
  });

  it('remembers "always allow" and then auto-approves the exact command', async () => {
    const { client } = await h.connectClient();
    let asked = 0;
    const onReq = (req: ApprovalRequest) => {
      asked++;
      void h.gateway.approvals.decide(req.id, { action: 'allow', scope: 'always' });
    };
    h.gateway.approvals.on('request', onReq);
    await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'touch /tmp/gh-always' } });
    const second = toolText(await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'touch /tmp/gh-always' } }));
    h.gateway.approvals.off('request', onReq);
    expect(asked).toBe(1);
    expect(second).toContain('allowlist');
    expect(h.store.findHostByAlias('web')!.ai.allowPatterns).toContain('touch /tmp/gh-always');
  });

  it('blocks catastrophic commands without asking', async () => {
    const { client } = await h.connectClient();
    const res = await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'rm -rf / --no-preserve-root' } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('always blocks');
  });

  it('refuses non-read-only commands on read-only hosts', async () => {
    h.addHost({ alias: 'ro', ai: { mode: 'read-only', fileWrite: 'deny', allowPatterns: [], denyPatterns: [], requireTouchId: false, description: '' } });
    const { client } = await h.connectClient();
    const ok = toolText(await client.callTool({ name: 'run_command', arguments: { host: 'ro', command: 'uname -s' } }));
    expect(ok).toContain('Linux');
    const res = await client.callTool({ name: 'run_command', arguments: { host: 'ro', command: 'mkdir /tmp/x' } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('read-only');
  });

  it('times out unanswered approvals', async () => {
    h.store.updateSettings({ ai: { approvalTimeoutSec: 1 } });
    const { client } = await h.connectClient();
    const res = await client.callTool({ name: 'run_command', arguments: { host: 'web', command: 'touch /tmp/gh-timeout' } });
    h.store.updateSettings({ ai: { approvalTimeoutSec: 120 } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('did not respond');
  });

  it('pauses everything with the kill switch', async () => {
    const { client } = await h.connectClient();
    h.gateway.setEnabled(false);
    const res = await client.callTool({ name: 'list_hosts', arguments: {} });
    h.gateway.setEnabled(true);
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('paused');
  });

  it('approves file writes and redacts file contents on read', async () => {
    const { client } = await h.connectClient();
    const onReq = (req: ApprovalRequest) => void h.gateway.approvals.decide(req.id, { action: 'allow', scope: 'once' });
    h.gateway.approvals.on('request', onReq);
    const w = toolText(await client.callTool({ name: 'write_file', arguments: { host: 'web', path: '/tmp/gh-mcp.txt', content: 'server=10.9.8.7\npassword=hunter22\n' } }));
    h.gateway.approvals.off('request', onReq);
    expect(w).toContain('wrote');
    const r = toolText(await client.callTool({ name: 'read_file', arguments: { host: 'web', path: '/tmp/gh-mcp.txt' } }));
    expect(r).not.toContain('10.9.8.7');
    expect(r).not.toContain('hunter22');
    expect(r).toContain('password=[redacted]');
    const ls = toolText(await client.callTool({ name: 'list_directory', arguments: { host: 'web', path: '/tmp' } }));
    expect(ls).toContain('gh-mcp.txt');
  });

  it('asks before reading credential files', async () => {
    const { client } = await h.connectClient();
    const causes: string[] = [];
    const onReq = (req: ApprovalRequest) => {
      causes.push(req.cause);
      void h.gateway.approvals.decide(req.id, { action: 'deny' });
    };
    h.gateway.approvals.on('request', onReq);
    const res = await client.callTool({ name: 'read_file', arguments: { host: 'web', path: '.ssh/authorized_keys2.pem' } });
    h.gateway.approvals.off('request', onReq);
    expect(causes).toEqual(['sensitive']);
    expect(res.isError).toBe(true);
  });

  it('runs trusted snippets without asking', async () => {
    const { client } = await h.connectClient();
    const listed = toolText(await client.callTool({ name: 'list_snippets', arguments: {} }));
    expect(listed).toContain('System overview');
    const out = toolText(await client.callTool({ name: 'run_snippet', arguments: { host: 'web', name: 'System overview' } }));
    expect(out).toContain('trusted snippet');
    expect(out).toContain('load average');
  });

  it('reports host info and records an intact, hash-chained audit trail', async () => {
    const { client } = await h.connectClient();
    const info = toolText(await client.callTool({ name: 'get_host_info', arguments: { host: 'web' } }));
    expect(info).toContain('cpus:');
    await h.gateway.audit.flush();
    const { entries } = await h.gateway.audit.query({ limit: 500 });
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.some((e) => e.outcome === 'denied' && e.userMessage === 'check the logs first')).toBe(true);
    expect(entries.some((e) => e.outcome === 'blocked')).toBe(true);
    const verify = await h.gateway.audit.verify();
    expect(verify.ok).toBe(true);
    // Tampering is detected.
    const file = join(h.home, 'audit', readdir(join(h.home, 'audit'))[0]);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines[2] = lines[2].replace('"outcome":"auto"', '"outcome":"approved"').replace('"outcome":"blocked"', '"outcome":"auto"');
    writeFileSync(file, lines.join('\n'));
    const tampered = await h.gateway.audit.verify();
    expect(tampered.ok).toBe(false);
  });

  it('enforces the per-minute rate limit', async () => {
    h.store.updateSettings({ ai: { rateLimitPerMinute: 2 } });
    const { client } = await h.connectClient();
    (h.gateway as unknown as { callTimes: number[] }).callTimes = [];
    await client.callTool({ name: 'list_hosts', arguments: {} });
    await client.callTool({ name: 'list_hosts', arguments: {} });
    const third = await client.callTool({ name: 'list_hosts', arguments: {} });
    h.store.updateSettings({ ai: { rateLimitPerMinute: 30 } });
    expect(third.isError).toBe(true);
    expect(toolText(third)).toContain('Rate limit');
  });

  it('rejects bridges with a wrong token', async () => {
    const endpoint = JSON.parse(readFileSync(join(h.home, 'run', 'endpoint.json'), 'utf8')) as { socket: string };
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(endpoint.socket, () => s.write(JSON.stringify({ type: 'hello', protocol: 1, token: 'nope' }) + '\n'));
      s.on('data', (d) => resolve(d.toString()));
    });
    expect(reply).toContain('"ok":false');
  });
});

function readdir(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
}
