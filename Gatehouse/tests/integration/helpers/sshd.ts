// Spins up a throwaway OpenSSH server on 127.0.0.1 for integration tests.
// Requires root (it creates a local test user) and /usr/sbin/sshd.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

export interface TestSshd {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPem: string;
  pubKey: string;
  hostKeyType: string;
  hostKeyB64: string;
  dir: string;
  stop(): void;
}

export const SSHD_AVAILABLE = existsSync('/usr/sbin/sshd') && typeof process.getuid === 'function' && process.getuid() === 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('sshd did not start'));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/** `overrides` replaces sshd_config settings by keyword, e.g. { PasswordAuthentication: 'no' }. */
export async function startSshd(overrides: Record<string, string> = {}): Promise<TestSshd> {
  const dir = mkdtempSync('/tmp/gh-sshd-');
  const user = 'ghtest';
  const password = 'Gatehouse-Test-1!';
  try {
    execFileSync('id', [user], { stdio: 'ignore' });
  } catch {
    execFileSync('useradd', ['-m', '-s', '/bin/bash', user]);
  }
  execFileSync('chpasswd', { input: `${user}:${password}\n` });
  mkdirSync('/run/sshd', { recursive: true });

  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host_ed25519')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'gatehouse-test', '-f', join(dir, 'client')]);
  const home = `/home/${user}`;
  const sshDir = join(home, '.ssh');
  mkdirSync(sshDir, { recursive: true });
  const pubKey = readFileSync(join(dir, 'client.pub'), 'utf8').trim();
  writeFileSync(join(sshDir, 'authorized_keys'), pubKey + '\n');
  chmodSync(sshDir, 0o700);
  chmodSync(join(sshDir, 'authorized_keys'), 0o600);
  execFileSync('chown', ['-R', `${user}:${user}`, sshDir]);

  const port = await freePort();
  const config = join(dir, 'sshd_config');
  writeFileSync(
    config,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(dir, 'host_ed25519')}`,
      `PidFile ${join(dir, 'sshd.pid')}`,
      'AuthorizedKeysFile .ssh/authorized_keys',
      'PasswordAuthentication yes',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'PermitRootLogin no',
      'Subsystem sftp internal-sftp',
      'AllowTcpForwarding yes',
      'StrictModes no',
      'MaxSessions 30',
      'MaxStartups 100',
      'LogLevel ERROR',
      '',
    ]
      .map((line) => {
        const key = line.split(' ')[0];
        return key in overrides ? `${key} ${overrides[key]}` : line;
      })
      .join('\n'),
  );
  execFileSync('/usr/sbin/sshd', ['-t', '-f', config]);
  const child: ChildProcess = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    if (!/Connection (closed|reset)|Received disconnect|Disconnected from/.test(s)) process.stderr.write(`[sshd] ${s}`);
  });
  await waitForPort(port);

  const hostPub = readFileSync(join(dir, 'host_ed25519.pub'), 'utf8').trim().split(/\s+/);
  return {
    host: '127.0.0.1',
    port,
    user,
    password,
    keyPem: readFileSync(join(dir, 'client'), 'utf8'),
    pubKey,
    hostKeyType: hostPub[0],
    hostKeyB64: hostPub[1],
    dir,
    stop: () => child.kill('SIGTERM'),
  };
}
