// Shared environment for UI tests and screenshots: a throwaway sshd, an
// ssh-agent holding the client key, and a seeded Gatehouse data directory.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitPort(port, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => (s.destroy(), r(true)));
      s.once('error', () => (s.destroy(), r(false)));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('port not ready');
}

async function startSshd() {
  const dir = fs.mkdtempSync('/tmp/gh-e2e-sshd-');
  const user = 'ghtest';
  try {
    execFileSync('id', [user], { stdio: 'ignore' });
  } catch {
    execFileSync('useradd', ['-m', '-s', '/bin/bash', user]);
  }
  execFileSync('chpasswd', { input: `${user}:Gatehouse-Test-1!\n` });
  fs.mkdirSync('/run/sshd', { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host_ed25519')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'gatehouse-e2e', '-f', path.join(dir, 'client')]);
  const sshDir = `/home/${user}/.ssh`;
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(path.join(sshDir, 'authorized_keys'), fs.readFileSync(path.join(dir, 'client.pub')));
  execFileSync('chown', ['-R', `${user}:${user}`, sshDir]);
  fs.chmodSync(sshDir, 0o700);
  // Some demo content for the file browser and terminal.
  const home = `/home/${user}`;
  fs.mkdirSync(path.join(home, 'projects/pacs-bridge/config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects/pacs-bridge/README.md'), '# PACS bridge\n\nForwards DICOM studies from the modality worklist to the archive.\n');
  fs.writeFileSync(path.join(home, 'projects/pacs-bridge/config/bridge.yml'), 'listen: 0.0.0.0:104\narchive: 10.12.4.20:11112\nao_title: GATEHOUSE\n');
  fs.writeFileSync(path.join(home, 'projects/pacs-bridge/compose.yml'), 'services:\n  bridge:\n    image: example/pacs-bridge:2.4\n    restart: unless-stopped\n');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs/bridge.log'), Array.from({ length: 40 }, (_, i) => `2026-11-05T08:${String(i).padStart(2, '0')}:12Z INFO  study forwarded uid=1.2.840.${10000 + i} from 10.12.4.${40 + (i % 9)}`).join('\n') + '\n');
  execFileSync('chown', ['-R', `${user}:${user}`, home]);
  const port = await freePort();
  const cfg = path.join(dir, 'sshd_config');
  fs.writeFileSync(
    cfg,
    [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${path.join(dir, 'host_ed25519')}`, `PidFile ${path.join(dir, 'pid')}`, 'PasswordAuthentication yes', 'KbdInteractiveAuthentication no', 'UsePAM no', 'PermitRootLogin no', 'Subsystem sftp internal-sftp', 'AllowTcpForwarding yes', 'StrictModes no', 'MaxSessions 40', 'LogLevel ERROR', ''].join('\n'),
  );
  const child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', cfg], { stdio: 'ignore' });
  await waitPort(port);
  const hostPub = fs.readFileSync(path.join(dir, 'host_ed25519.pub'), 'utf8').trim().split(/\s+/);
  return { dir, port, user, child, hostKeyType: hostPub[0], hostKeyB64: hostPub[1], clientKey: path.join(dir, 'client') };
}

function startAgent(keyFile) {
  const out = execFileSync('ssh-agent', ['-s'], { encoding: 'utf8' });
  const sock = /SSH_AUTH_SOCK=([^;]+);/.exec(out)[1];
  const pid = Number(/SSH_AGENT_PID=(\d+);/.exec(out)[1]);
  execFileSync('ssh-add', ['-q', keyFile], { env: { ...process.env, SSH_AUTH_SOCK: sock } });
  return { sock, stop: () => process.kill(pid) };
}

function host(partial) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    alias: 'host',
    name: '',
    hostname: '',
    port: 22,
    username: '',
    auth: 'agent',
    savePassword: false,
    group: '',
    tags: [],
    color: 'blue',
    notes: '',
    keepAliveSec: 30,
    startupCommand: '',
    favorite: false,
    legacyAlgorithms: false,
    ai: { mode: 'ask', fileWrite: 'ask', allowPatterns: [], denyPatterns: [], requireTouchId: false, description: '' },
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

function seedHome(sshd, { onboardingDone = true } = {}) {
  const home = fs.mkdtempSync('/tmp/gh-e2e-home-');
  const lab = host({ alias: 'lab-gpu', name: 'Lab GPU server', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, color: 'indigo', group: 'Research', tags: ['gpu', 'ubuntu'], favorite: true, osInfo: 'Ubuntu 24.04.5 LTS', lastConnectedAt: Date.now() - 3600_000, ai: { mode: 'ask', fileWrite: 'ask', allowPatterns: ['docker compose logs *'], denyPatterns: [], requireTouchId: false, description: 'Ubuntu 24.04 research box; runs the PACS bridge in Docker' } });
  const hosts = [
    lab,
    host({ alias: 'prod-web', name: 'Production web', hostname: 'web-01.example.org', username: 'deploy', color: 'green', group: 'Production', tags: ['nginx', 'docker'], osInfo: 'Debian 12', lastConnectedAt: Date.now() - 86400_000 * 2, ai: { mode: 'trusted', fileWrite: 'ask', allowPatterns: [], denyPatterns: ['systemctl stop *'], requireTouchId: false, description: 'Public website (nginx + docker compose)' } }),
    host({ alias: 'db-primary', name: 'Postgres primary', hostname: '10.12.4.31', port: 2222, username: 'postgres', color: 'orange', group: 'Production', tags: ['postgres'], ai: { mode: 'ask', fileWrite: 'deny', allowPatterns: [], denyPatterns: [], requireTouchId: true, description: 'PostgreSQL 16 primary' } }),
    host({ alias: 'pacs-gw', name: 'PACS gateway', hostname: '10.12.4.20', username: 'admin', auth: 'password', color: 'teal', group: 'Hospital', tags: ['dicom'], ai: { mode: 'read-only', fileWrite: 'deny', allowPatterns: [], denyPatterns: [], requireTouchId: false, description: 'Read-only: DICOM gateway' } }),
    host({ alias: 'backup-nas', name: 'Backup NAS', hostname: 'nas.home.arpa', username: 'backup', color: 'gray', group: 'Home', ai: { mode: 'off', fileWrite: 'deny', allowPatterns: [], denyPatterns: [], requireTouchId: false, description: '' } }),
  ];
  const now = Date.now();
  const snip = (name, command, description, aiAllowed, tags) => ({ id: crypto.randomUUID(), name, command, description, tags, aiAllowed, createdAt: now, updatedAt: now });
  const data = {
    version: 1,
    hosts,
    keys: [],
    knownHosts: [{ id: crypto.randomUUID(), host: '127.0.0.1', port: sshd.port, keyType: sshd.hostKeyType, fingerprint: 'pinned-by-test', publicKey: sshd.hostKeyB64, addedAt: now, lastSeenAt: now }],
    forwards: [
      { id: crypto.randomUUID(), name: 'Grafana dashboard', hostId: lab.id, type: 'local', bindAddress: '127.0.0.1', bindPort: 13000, destHost: '127.0.0.1', destPort: sshd.port, autoStart: false },
      { id: crypto.randomUUID(), name: 'Lab SOCKS proxy', hostId: lab.id, type: 'dynamic', bindAddress: '127.0.0.1', bindPort: 11080, destHost: '', destPort: 0, autoStart: false },
    ],
    snippets: [
      snip('System overview', 'uptime && free -h && df -h -x tmpfs -x devtmpfs', 'Load, memory and disk usage at a glance.', true, ['health']),
      snip('Top processes', 'ps aux --sort=-%cpu | head -15', 'The 15 busiest processes by CPU.', true, ['health']),
      snip('Listening ports', 'ss -tlnp', 'TCP sockets in LISTEN state with owning processes.', true, ['network']),
      snip('Restart PACS bridge', 'docker compose -f ~/projects/pacs-bridge/compose.yml restart', 'Restarts the DICOM forwarding container.', false, ['docker']),
      snip('Recent errors', 'journalctl -p err -n 50 --no-pager', 'The last 50 error-level journal entries.', true, ['logs']),
    ],
    settings: { onboardingDone, language: 'en', theme: 'light', confirmOnQuit: false },
  };
  fs.writeFileSync(path.join(home, 'gatehouse.json'), JSON.stringify(data, null, 2));
  return { home, hosts };
}

module.exports = { startSshd, startAgent, seedHome };
