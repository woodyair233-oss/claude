// Exercises the Windows exec transport over a real SSH exec channel, using the
// winshim fakes (powershell.exe / wsl.exe / taskkill.exe). This validates the
// code Gatehouse actually runs — the -EncodedCommand packaging, the PID +
// code-page marker stripping, GBK output decoding, exit codes, the stdin
// fallback for long commands, and the Windows kill path — without needing a
// real PowerShell (which cannot be installed here).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { execCommand } from '../../src/main/ssh/exec';
import type { ShellTarget } from '../../src/shared/types';
import { SSHD_AVAILABLE, startSshd, type TestSshd } from './helpers/sshd';
import { installWinShims, removeWinShims } from './helpers/winshim';

const d = SSHD_AVAILABLE ? describe : describe.skip;

const PS: ShellTarget = { kind: 'powershell', edition: 'desktop' };

d('Windows exec transport (real sshd + shims)', () => {
  let sshd: TestSshd;
  let client: ssh2.Client;

  beforeAll(async () => {
    installWinShims();
    sshd = await startSshd();
    client = await connect(sshd);
  });
  afterAll(() => {
    try {
      client?.end();
    } catch {
      /* ignore */
    }
    sshd?.stop();
    removeWinShims();
  });

  it('runs a PowerShell command and returns clean output (marker stripped)', async () => {
    const r = await execCommand(client, "printf 'hello world\\n'", { timeoutMs: 15_000, shell: PS });
    expect(r.stdout.trim()).toBe('hello world');
    expect(r.stderr).not.toContain('\u001e');
    expect(r.stderr).not.toContain('GHPID');
    expect(r.exitCode).toBe(0);
  });

  it('propagates a non-zero exit code', async () => {
    const r = await execCommand(client, 'exit 7', { timeoutMs: 15_000, shell: PS });
    expect(r.exitCode).toBe(7);
  });

  it('decodes legacy GBK output (the Chinese-Windows mojibake case)', async () => {
    // Emit the GBK bytes for 中文 while the marker advertises code page 936.
    const r = await execCommand(client, "printf '\\xd6\\xd0\\xce\\xc4'", { timeoutMs: 15_000, shell: PS });
    expect(r.stdout).toContain('中文');
  });

  it('keeps stderr (minus the marker)', async () => {
    const r = await execCommand(client, "printf 'oops\\n' 1>&2; exit 2", { timeoutMs: 15_000, shell: PS });
    expect(r.stderr).toContain('oops');
    expect(r.stderr).not.toContain('GHPID');
    expect(r.exitCode).toBe(2);
  });

  it('delivers a long command over stdin and runs it intact', async () => {
    // 5000 chars forces the exec string past the inline cap, so the payload
    // travels on standard input instead.
    const n = 5000;
    const r = await execCommand(client, `printf '%s' "$(printf 'x%.0s' $(seq 1 ${n}))"`, { timeoutMs: 20_000, shell: PS });
    expect(r.stdout.length).toBe(n);
    expect(/^x+$/.test(r.stdout)).toBe(true);
  });

  // The WSL path's outer layer is genuine PowerShell (& wsl.exe, $env:), which a
  // bash shim cannot interpret, so it is not run end-to-end here. Its POSIX inner
  // layer is validated through real bash in tests/unit/windows-exec.test.ts, and
  // the wsl.exe command line is asserted there too.

  it('times out and stops a long-running command promptly', async () => {
    const start = Date.now();
    const r = await execCommand(client, 'sleep 30; echo done', { timeoutMs: 1500, shell: PS });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).not.toContain('done');
    expect(Date.now() - start).toBeLessThan(9000);
  });
});

function connect(sshd: TestSshd): Promise<ssh2.Client> {
  return new Promise((resolve, reject) => {
    const c = new ssh2.Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    c.connect({ host: sshd.host, port: sshd.port, username: sshd.user, privateKey: sshd.keyPem, readyTimeout: 20_000 });
  });
}
