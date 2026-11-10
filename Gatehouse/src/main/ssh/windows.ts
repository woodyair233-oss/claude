// Running commands on Windows hosts.
//
// Win32-OpenSSH hands an exec request to the account's default shell (cmd.exe
// unless changed, often powershell.exe), which parses it with its own rules.
// So the exec string Gatehouse sends contains only an executable name,
// switches and base64: it means the same thing to cmd.exe, Windows PowerShell
// 5.1, PowerShell 7 and bash. The real command travels base64-encoded inside a
// small PowerShell script (Windows PowerShell 5.1 syntax, which PowerShell 7
// also runs), or over standard input when it is too long for a command line.
// WSL commands are started from that same script through wsl.exe.

import type { PowerShellEdition, ShellTarget } from '../../shared/types';
import { shellQuote, wrapCommand } from './wrap';

/** cmd.exe accepts command lines up to 8191 characters; keep the exec string under it. */
export const MAX_INLINE_EXEC = 8000;
/** CreateProcess limit for the wsl.exe command line, which carries the WSL script. */
const MAX_WSL_ARG = 30_000;

export interface PreparedExec {
  /** The exec request string. */
  command: string;
  /** Sent on standard input, then closed. */
  stdin?: Buffer;
  windows: boolean;
}

export function powershellExe(edition: PowerShellEdition | undefined): string {
  return edition === 'core' ? 'pwsh.exe' : 'powershell.exe';
}

const PS_SWITCHES = '-NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text';

/** -EncodedCommand takes base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * The PowerShell script that runs `source` (a PowerShell command line). It:
 * reports its process id and console code page on stderr (for timeouts and
 * decoding), switches output to UTF-8, widens the formatting width, compiles
 * the command (a syntax error is reported without running anything), runs it,
 * and exits with a bash-like status: 0 when the last statement succeeded,
 * otherwise the last native exit code, or 1.
 *
 * `payload` is the base64 of the command's UTF-8 text, or null to read that
 * base64 from standard input.
 */
export function powershellBootstrap(payload: string | null): string {
  const read = payload === null ? `(($input|Out-String) -replace '\\s','')` : `'${payload}'`;
  return [
    `$ProgressPreference='SilentlyContinue'`,
    `$__ghU=New-Object System.Text.UTF8Encoding $false`,
    `$__ghCp=0`,
    `try{$__ghCp=[Console]::OutputEncoding.CodePage}catch{}`,
    `try{[Console]::Error.Write([string][char]30+'GHPID:'+$PID+':'+$__ghCp+[string][char]30)}catch{}`,
    `$__ghC=$__ghU.GetString([Convert]::FromBase64String(${read}))`,
    `try{[Console]::OutputEncoding=$__ghU}catch{}`,
    `$OutputEncoding=$__ghU`,
    `try{$__ghS=$Host.UI.RawUI.BufferSize;if($__ghS.Width -lt 400){$__ghS.Width=400;$Host.UI.RawUI.BufferSize=$__ghS}}catch{}`,
    `if($PSVersionTable.PSVersion.Major -ge 7){try{$PSStyle.OutputRendering='PlainText'}catch{}}`,
    // The appended line records the status of the command's last statement. A
    // command it cannot follow (named begin/process/end blocks) compiles as is.
    `$__ghB=$null`,
    `try{$__ghB=[ScriptBlock]::Create($__ghC+[Environment]::NewLine+'$global:__ghQ=$?')}catch{}`,
    `if($null -eq $__ghB){try{$__ghB=[ScriptBlock]::Create($__ghC)}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}}`,
    `$global:__ghQ=$true`,
    `$global:LASTEXITCODE=0`,
    `& $__ghB`,
    `if(-not $global:__ghQ){if($global:LASTEXITCODE){exit $global:LASTEXITCODE};exit 1}`,
    `exit 0`,
  ].join('\n');
}

/** Builds the exec request for a PowerShell command line. */
export function powershellExec(edition: PowerShellEdition | undefined, source: string): PreparedExec {
  const exe = powershellExe(edition);
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  const inline = `${exe} ${PS_SWITCHES} -EncodedCommand ${encodePowerShell(powershellBootstrap(b64))}`;
  if (inline.length <= MAX_INLINE_EXEC) return { command: inline, windows: true };
  return {
    command: `${exe} ${PS_SWITCHES} -EncodedCommand ${encodePowerShell(powershellBootstrap(null))}`,
    stdin: Buffer.from(b64 + '\n', 'ascii'),
    windows: true,
  };
}

/** A PowerShell single-quoted string literal (PowerShell also treats curly single quotes as quotes). */
export function psQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/**
 * The POSIX side of a WSL command. It starts in the Linux home directory, runs
 * the command in its own session when `setsid -w` is available (so a timeout
 * can stop everything it started), and reports the Linux process id.
 */
export function wslPosixScript(command: string): string {
  const inner = shellQuote(`printf '\\036GHLPID:%s\\036' "$$" >&2; eval "$1"`);
  const q = shellQuote(command);
  return (
    `cd "$HOME" 2>/dev/null; gh_s=; setsid -w true 2>/dev/null && gh_s='setsid -w'; ` +
    `command -v bash >/dev/null 2>&1 && exec $gh_s bash -lc ${inner} gatehouse ${q}; exec $gh_s sh -lc ${inner} gatehouse ${q}`
  );
}

function wslPrefix(distro: string | undefined): string {
  return `$env:WSL_UTF8='1'; & wsl.exe ${distro ? `-d ${psQuote(distro)} ` : ''}`;
}

/**
 * The PowerShell line that runs a POSIX command in WSL. The script reaches
 * Linux as base64 in an argument that has neither double quotes nor
 * backslashes, which Windows PowerShell 5.1 passes to native programs intact.
 */
export function wslPowerShell(distro: string | undefined, command: string): string {
  const b64 = Buffer.from(wslPosixScript(command), 'utf8').toString('base64');
  if (b64.length > MAX_WSL_ARG) throw new Error('The command is too long to run in WSL. Shorten it, or write a script with write_file and run that.');
  return `${wslPrefix(distro)}-e sh -c 'printf %s $1|base64 -d|sh' gatehouse '${b64}'`;
}

export function prepareExec(target: ShellTarget | undefined, command: string): PreparedExec {
  if (!target || target.kind === 'posix') return { command: wrapCommand(command), windows: false };
  if (target.kind === 'powershell') return powershellExec(target.edition, command);
  return powershellExec(target.edition, wslPowerShell(target.distro, command));
}

/**
 * Exec requests that stop a command that timed out or was cancelled: inside
 * WSL first (TERM, then KILL), then the Windows process tree.
 */
export function windowsKillCommands(target: ShellTarget, pids: { win?: number; linux?: number }): { linux?: string; win?: string } {
  const out: { linux?: string; win?: string } = {};
  const lp = pids.linux;
  if (target.kind === 'wsl' && lp) {
    const sh = `kill -TERM -- -${lp} 2>/dev/null || kill -TERM ${lp} 2>/dev/null; sleep 1; kill -KILL -- -${lp} 2>/dev/null || kill -KILL ${lp} 2>/dev/null; true`;
    out.linux = powershellExec(target.edition, `${wslPrefix(target.distro)}-e sh -c ${psQuote(sh)}`).command;
  }
  if (pids.win) out.win = `taskkill.exe /T /F /PID ${pids.win}`;
  return out;
}

// ---------------------------------------------------------------------------
// Output decoding

/** Windows code pages Gatehouse can decode, by WHATWG encoding label. */
const CODE_PAGES: Record<number, string> = {
  936: 'gbk',
  54936: 'gb18030',
  950: 'big5',
  932: 'shift_jis',
  949: 'euc-kr',
  866: 'ibm866',
  874: 'windows-874',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  // OEM code pages without a WHATWG decoder: the Western ANSI page is the closest.
  437: 'windows-1252',
  850: 'windows-1252',
  858: 'windows-1252',
};

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const decoders = new Map<string, TextDecoder>();

function decoderFor(label: string): TextDecoder | undefined {
  let d = decoders.get(label);
  if (!d) {
    try {
      d = new TextDecoder(label);
    } catch {
      return undefined;
    }
    decoders.set(label, d);
  }
  return d;
}

/** wsl.exe writes its own messages in UTF-16LE: mostly NUL high bytes. */
function looksUtf16le(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  let start = 0;
  if (buf[0] === 0xff && buf[1] === 0xfe) start = 2;
  let pairs = 0;
  let zeroHigh = 0;
  for (let i = start; i + 1 < buf.length && pairs < 4096; i += 2, pairs++) if (buf[i + 1] === 0 && buf[i] !== 0) zeroHigh++;
  return pairs > 0 && zeroHigh / pairs > 0.6;
}

/**
 * Decodes Windows output: UTF-8 where it is valid, the console's previous code
 * page (reported by the bootstrap) for lines that are not, and UTF-16LE for
 * wsl.exe's own messages.
 */
export function decodeWindowsOutput(buf: Buffer, codePage?: number): string {
  if (!buf.length) return '';
  if (looksUtf16le(buf)) {
    const start = buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0;
    return buf.subarray(start).toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try {
    return utf8Strict.decode(buf);
  } catch {
    /* mixed or legacy encoding: go line by line */
  }
  const legacy = codePage && CODE_PAGES[codePage] ? decoderFor(CODE_PAGES[codePage]) : undefined;
  const lines: string[] = [];
  let from = 0;
  while (from <= buf.length) {
    let nl = buf.indexOf(0x0a, from);
    if (nl < 0) nl = buf.length;
    const line = buf.subarray(from, nl);
    let text: string;
    try {
      text = utf8Strict.decode(line);
    } catch {
      text = legacy ? legacy.decode(line) : line.toString('utf8');
    }
    lines.push(text);
    from = nl + 1;
  }
  return lines.join('\n');
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/**
 * PowerShell sometimes writes its error stream as CLIXML ("#< CLIXML" and
 * serialised objects). Keeps the error, warning and information text and
 * drops progress records.
 */
export function decodeClixml(text: string): string {
  if (!text.includes('#< CLIXML')) return text;
  return text.replace(/#< CLIXML\r?\n?(<Objs[\s\S]*?<\/Objs>)/g, (_all, xml: string) => {
    const lines: string[] = [];
    const re = /<S S="(Error|Warning|Verbose|Debug|Information)">([\s\S]*?)<\/S>/g;
    let m: RegExpExecArray | null;
    let current = '';
    while ((m = re.exec(xml))) {
      const value = m[2]
        .replace(/&(lt|gt|amp|quot|apos);/g, (_e, n: string) => XML_ENTITIES[n])
        .replace(/_x([0-9A-Fa-f]{4})_/g, (_e, h: string) => String.fromCharCode(parseInt(h, 16)));
      current += value;
      if (/\r?\n$/.test(value)) {
        lines.push(current.replace(/\r?\n$/, ''));
        current = '';
      }
    }
    if (current) lines.push(current);
    return lines.join('\n');
  });
}
