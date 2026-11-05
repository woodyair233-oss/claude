// One-click configuration of MCP clients and a self-test of the bridge.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SelfTestResult, SetupInfo } from '../../shared/types';
import { MCP_SERVER_NAME } from '../../shared/defaults';
import { writeFileAtomicSync } from '../fsutil';

function quoteArg(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` } }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1 : 0;
      resolve({ code: typeof code === 'number' ? code : 1, out: `${stdout}${stderr}`.trim() });
    });
  });
}

let cachedCli: string | undefined | null = null;

export async function findClaudeCli(): Promise<string | undefined> {
  if (cachedCli !== null) return cachedCli;
  const home = homedir();
  const candidates = [
    join(home, '.claude', 'local', 'claude'),
    join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
    join(home, '.volta', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedCli = c;
      return c;
    }
  }
  // GUI apps do not inherit the login shell PATH; ask the user's shell.
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  if (existsSync(shell)) {
    const r = await run(shell, ['-lc', 'command -v claude'], 8000);
    const path = r.out.split('\n').pop()?.trim();
    if (r.code === 0 && path && path.startsWith('/') && existsSync(path)) {
      cachedCli = path;
      return path;
    }
  }
  cachedCli = undefined;
  return undefined;
}

export function isClaudeDesktopConfigured(bridge: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(claudeDesktopConfigPath(), 'utf8')) as { mcpServers?: Record<string, { command?: string }> };
    return cfg.mcpServers?.[MCP_SERVER_NAME]?.command === bridge;
  } catch {
    return false;
  }
}

export async function setupInfo(bridge: string, bridgeExists: boolean): Promise<SetupInfo> {
  const cli = await findClaudeCli();
  return {
    bridgePath: bridge,
    bridgeExists,
    claudeCodeCommand: `claude mcp add --scope user ${MCP_SERVER_NAME} -- ${quoteArg(bridge)}`,
    claudeCodeCli: cli,
    claudeDesktopConfigPath: claudeDesktopConfigPath(),
    claudeDesktopConfigured: isClaudeDesktopConfigured(bridge),
    genericJson: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: bridge, args: [] } } }, null, 2),
  };
}

export async function installClaudeCode(bridge: string): Promise<{ ok: boolean; output: string }> {
  const cli = await findClaudeCli();
  if (!cli) return { ok: false, output: 'Claude Code (the `claude` command) was not found. Run the command shown in Terminal instead.' };
  await run(cli, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
  const r = await run(cli, ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', bridge]);
  return { ok: r.code === 0, output: r.out || (r.code === 0 ? 'Added.' : 'Failed.') };
}

export function installClaudeDesktop(bridge: string): { ok: boolean; message: string } {
  const path = claudeDesktopConfigPath();
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, message: `${path} is not valid JSON; fix it first so Gatehouse does not overwrite your settings.` };
    }
    copyFileSync(path, `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  }
  const servers = (typeof cfg.mcpServers === 'object' && cfg.mcpServers ? cfg.mcpServers : {}) as Record<string, unknown>;
  servers[MCP_SERVER_NAME] = { command: bridge, args: [] };
  cfg.mcpServers = servers;
  writeFileAtomicSync(path, JSON.stringify(cfg, null, 2) + '\n', 0o644);
  return { ok: true, message: 'Added to Claude Desktop. Quit and reopen Claude Desktop to load it.' };
}

/** Runs the real bridge binary: --doctor, then an MCP initialize + tools/list round trip. */
export async function selfTest(bridge: string, env: NodeJS.ProcessEnv): Promise<SelfTestResult> {
  const steps: SelfTestResult['steps'] = [];
  if (!existsSync(bridge)) {
    steps.push({ name: 'bridge', ok: false, detail: `Bridge not found at ${bridge}` });
    return { ok: false, steps };
  }
  steps.push({ name: 'bridge', ok: true, detail: bridge });
  const doctor = await run(bridge, ['--doctor', '--no-launch'], 10_000);
  steps.push({ name: 'doctor', ok: doctor.code === 0, detail: doctor.out.split('\n').pop() });
  if (doctor.code !== 0) return { ok: false, steps };

  const handshake = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const child = spawn(bridge, ['--no-launch', '--label', 'self-test'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, detail: 'Timed out waiting for the MCP handshake.' });
    }, 10_000);
    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const lines = out.split('\n');
      for (const line of lines.slice(0, -1)) {
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[]; serverInfo?: { name: string } } };
          if (msg.id === 1 && msg.result) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            child.stdin.end();
            setTimeout(() => child.kill(), 500);
            resolve({ ok: true, detail: `${msg.result.tools.length} tools: ${msg.result.tools.map((t) => t.name).join(', ')}` });
          }
        } catch {
          /* partial */
        }
      }
      out = lines[lines.length - 1];
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.trim() || `Bridge exited with code ${code}` });
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gatehouse-self-test', version: '1.0.0' } },
    });
  });
  steps.push({ name: 'mcp', ok: handshake.ok, detail: handshake.detail });
  return { ok: steps.every((s) => s.ok), steps };
}
