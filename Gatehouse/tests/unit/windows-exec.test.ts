import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  decodeClixml,
  decodeWindowsOutput,
  encodePowerShell,
  powershellBootstrap,
  powershellExec,
  prepareExec,
  windowsKillCommands,
  wslPosixScript,
  wslPowerShell,
} from '../../src/main/ssh/windows';
import { MarkerFilter } from '../../src/main/ssh/exec';
import { chooseShell } from '../../src/shared/shells';
import { defaultShellSettings } from '../../src/shared/defaults';

describe('PowerShell -EncodedCommand', () => {
  it('encodes as UTF-16LE base64 that PowerShell decodes', () => {
    const b64 = encodePowerShell('Write-Output 1');
    expect(Buffer.from(b64, 'base64').toString('utf16le')).toBe('Write-Output 1');
  });

  it('inlines a short command and carries it as UTF-8 base64', () => {
    const p = powershellExec('desktop', 'Get-Process');
    expect(p.command.startsWith('powershell.exe ')).toBe(true);
    expect(p.command).toContain('-EncodedCommand ');
    expect(p.stdin).toBeUndefined();
    const script = Buffer.from(p.command.split('-EncodedCommand ')[1], 'base64').toString('utf16le');
    const b64 = /FromBase64String\('([^']+)'\)/.exec(script)![1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Get-Process');
  });

  it('uses pwsh.exe for PowerShell 7', () => {
    expect(powershellExec('core', 'Get-Process').command.startsWith('pwsh.exe ')).toBe(true);
  });

  it('falls back to stdin for a very long command', () => {
    const p = powershellExec('desktop', 'Write-Output ' + 'x'.repeat(9000));
    expect(p.stdin).toBeInstanceOf(Buffer);
    const script = Buffer.from(p.command.split('-EncodedCommand ')[1], 'base64').toString('utf16le');
    expect(script).toContain('$input');
    // stdin carries the UTF-8 base64 of the real command
    const b64 = p.stdin!.toString('ascii').trim();
    expect(Buffer.from(b64, 'base64').toString('utf8')).toContain('Write-Output');
  });

  it('bootstrap avoids PowerShell 7-only syntax (5.1 compatible)', () => {
    const b = powershellBootstrap('AAAA');
    // No null-coalescing, null-conditional, ternary or chain operators.
    expect(b).not.toMatch(/\?\?|\?\.|&&|\|\|/);
    expect(b).not.toMatch(/\S\s*\?\s*\S+\s*:\s*\S/); // ternary a ? b : c
    // The one 7-only feature is guarded by a version check.
    expect(b).toContain('$PSVersionTable.PSVersion.Major -ge 7');
    // Emits the PID + code-page marker on stderr.
    expect(b).toContain("'GHPID:'+$PID");
    // Propagates a bash-like exit status.
    expect(b).toContain('exit 0');
    expect(b).toContain('$global:LASTEXITCODE');
  });
});

describe('WSL wrapping', () => {
  it('passes a distro through', () => {
    expect(wslPowerShell('Ubuntu', 'ls')).toContain("-d 'Ubuntu'");
    expect(wslPowerShell(undefined, 'ls')).not.toContain('-d ');
  });

  it('rejects an over-long command', () => {
    expect(() => wslPowerShell(undefined, 'echo ' + 'y'.repeat(40000))).toThrow(/too long/);
  });

  it('the POSIX layer runs under bash and reports the Linux PID', () => {
    const script = wslPosixScript('echo hello; echo oops 1>&2; exit 3');
    const r = runSh(script);
    expect(r.stdout).toContain('hello');
    expect(r.stderr).toContain('oops');
    expect(r.stderr).toMatch(/\x1eGHLPID:\d+\x1e/);
    expect(r.code).toBe(3);
  });

  it('the WSL powershell line base64 round-trips to the POSIX script', () => {
    const line = wslPowerShell('Ubuntu', 'uname -a');
    const b64 = /base64 -d\|sh' gatehouse '([^']+)'/.exec(line)![1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toContain('uname -a');
  });
});

describe('prepareExec dispatch', () => {
  it('posix wraps with bash', () => {
    const p = prepareExec({ kind: 'posix' }, 'ls');
    expect(p.windows).toBe(false);
    expect(p.command).toContain('bash -c');
  });
  it('powershell target', () => {
    expect(prepareExec({ kind: 'powershell', edition: 'desktop' }, 'ls').windows).toBe(true);
  });
  it('wsl target wraps POSIX inside powershell', () => {
    const p = prepareExec({ kind: 'wsl', edition: 'desktop', distro: 'Ubuntu' }, 'ls');
    expect(p.windows).toBe(true);
    expect(p.command).toContain('powershell.exe');
  });
});

describe('windowsKillCommands', () => {
  it('kills the Windows process tree', () => {
    const k = windowsKillCommands({ kind: 'powershell', edition: 'desktop' }, { win: 4321 });
    expect(k.win).toBe('taskkill.exe /T /F /PID 4321');
    expect(k.linux).toBeUndefined();
  });
  it('kills inside WSL first, then the host process', () => {
    const k = windowsKillCommands({ kind: 'wsl', edition: 'desktop', distro: 'Ubuntu' }, { win: 10, linux: 55 });
    expect(k.linux).toContain('powershell.exe');
    expect(k.win).toContain('/PID 10');
  });
});

describe('MarkerFilter', () => {
  it('strips the PID+codepage marker and keeps the rest', () => {
    const f = new MarkerFilter(false, 4096);
    const out = f.push(Buffer.from('\x1eGHPID:123:936\x1ereal error text')).toString('utf8');
    expect(out).toBe('real error text');
    expect(f.pid).toBe(123);
    expect(f.codePage).toBe(936);
  });

  it('handles a marker split across two chunks', () => {
    const f = new MarkerFilter(false, 4096);
    let out = f.push(Buffer.from('\x1eGHPID:7')).toString('utf8');
    out += f.push(Buffer.from('99:65001\x1eafter')).toString('utf8');
    out += f.flush().toString('utf8');
    expect(out).toBe('after');
    expect(f.pid).toBe(799);
  });

  it('captures the Linux PID for WSL', () => {
    const f = new MarkerFilter(true, 4096);
    const out = f.push(Buffer.from('\x1eGHPID:1:65001\x1e\x1eGHLPID:42\x1ehi')).toString('utf8');
    expect(out).toBe('hi');
    expect(f.pid).toBe(1);
    expect(f.linuxPid).toBe(42);
  });
});

describe('decodeWindowsOutput', () => {
  it('decodes UTF-8', () => {
    expect(decodeWindowsOutput(Buffer.from('héllo 中文', 'utf8'))).toBe('héllo 中文');
  });
  it('falls back to GBK for invalid UTF-8 (the 395 mojibake case)', () => {
    // 中文 in GBK:
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeWindowsOutput(gbk, 936)).toBe('中文');
  });
  it('decodes per line, keeping valid UTF-8 lines', () => {
    const buf = Buffer.concat([Buffer.from('ok ascii\n', 'utf8'), Buffer.from([0xd6, 0xd0, 0x0a]), Buffer.from('tail', 'utf8')]);
    const out = decodeWindowsOutput(buf, 936);
    expect(out).toContain('ok ascii');
    expect(out).toContain('中');
    expect(out).toContain('tail');
  });
  it('detects UTF-16LE (wsl.exe messages)', () => {
    expect(decodeWindowsOutput(Buffer.from('Error: no distro', 'utf16le'))).toBe('Error: no distro');
  });
});

describe('decodeClixml', () => {
  it('extracts the error text from a CLIXML error stream', () => {
    const xml = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://x"><S S="Error">rm : cannot find path_x000D__x000A_</S></Objs>';
    const out = decodeClixml(xml);
    expect(out).toContain('cannot find path');
    expect(out).not.toContain('CLIXML');
  });
  it('leaves plain text untouched', () => {
    expect(decodeClixml('just an error')).toBe('just an error');
  });
});

describe('chooseShell', () => {
  const win = (over: Partial<ReturnType<typeof defaultShellSettings>>) => ({
    alias: 'win', detectedPlatform: 'windows' as const, shell: { ...defaultShellSettings(), platform: 'windows' as const, ...over },
  });
  it('defaults a Windows host to PowerShell', () => {
    const r = chooseShell(win({}));
    expect(r.ok && r.target.kind).toBe('powershell');
  });
  it('honours a WSL request when enabled', () => {
    const r = chooseShell(win({ wsl: true }), 'wsl');
    expect(r.ok && r.target.kind).toBe('wsl');
  });
  it('refuses WSL when not enabled', () => {
    const r = chooseShell(win({ wsl: false }), 'wsl');
    expect(r.ok).toBe(false);
  });
  it('a posix host rejects a shell parameter', () => {
    const r = chooseShell({ alias: 'lx', detectedPlatform: 'posix', shell: defaultShellSettings() }, 'powershell');
    expect(r.ok).toBe(false);
  });
  it('a posix host runs bash', () => {
    const r = chooseShell({ alias: 'lx', detectedPlatform: 'posix', shell: defaultShellSettings() });
    expect(r.ok && r.target.kind).toBe('posix');
  });
});

function runSh(script: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('sh', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status ?? -1 };
  }
}
