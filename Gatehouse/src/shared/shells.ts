// Which shell a command runs in on a host: POSIX sh/bash on Linux and macOS;
// PowerShell or WSL on Windows. Shared by main (execution, policy) and the
// renderer (labels, editor).

import type { CommandAssessment, CommandShell, Host, HostShellSettings, PowerShellEdition, ShellTarget, WindowsShell } from './types';
import { defaultShellSettings } from './defaults';
import { assessCommand, type ClassifierOptions } from './command-policy';
import { assessPowerShellCommand } from './powershell-policy';

/** WSL distribution names: what `wsl --install` / `--import` accept. */
export const WSL_DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Repairs shell settings read from disk or another version. */
export function normalizeShellSettings(raw: unknown): HostShellSettings {
  const d = defaultShellSettings();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof HostShellSettings, unknown>>;
  return {
    platform: r.platform === 'posix' || r.platform === 'windows' || r.platform === 'auto' ? r.platform : d.platform,
    windowsDefault: r.windowsDefault === 'wsl' || r.windowsDefault === 'powershell' ? r.windowsDefault : d.windowsDefault,
    powershell: r.powershell === 'core' || r.powershell === 'desktop' ? r.powershell : d.powershell,
    wsl: typeof r.wsl === 'boolean' ? r.wsl : d.wsl,
    wslDistro: typeof r.wslDistro === 'string' && (r.wslDistro === '' || WSL_DISTRO_PATTERN.test(r.wslDistro)) ? r.wslDistro : d.wslDistro,
  };
}

/** True when the server's SSH software is a Windows SSH server. */
export function isWindowsServerSoftware(software: string | undefined): boolean {
  if (!software) return false;
  return /OpenSSH_for_Windows|WinSSHD|Bitvise|freeSSHd|KpyM|WeOnlyDo|Syncplify|SolarWinds|CoreFTP|Pragma/i.test(software);
}

/** The platform Gatehouse should assume, or undefined while it is still unknown. */
export function effectivePlatform(host: Pick<Host, 'shell' | 'detectedPlatform'>): 'posix' | 'windows' | undefined {
  if (host.shell.platform === 'posix') return 'posix';
  if (host.shell.platform === 'windows') return 'windows';
  return host.detectedPlatform;
}

export type ShellChoice = { ok: true; target: ShellTarget } | { ok: false; message: string };

/**
 * Picks the shell for one command. `requested` comes from Claude; it may only
 * name a shell the user enabled for the host.
 */
export function chooseShell(host: Pick<Host, 'alias' | 'shell' | 'detectedPlatform'>, requested?: string): ShellChoice {
  const platform = effectivePlatform(host) ?? 'posix';
  const want = requested && requested !== 'default' ? requested : undefined;
  if (platform === 'posix') {
    if (want && want !== 'bash' && want !== 'posix') {
      return { ok: false, message: `"${host.alias}" is a Linux/macOS host: commands run in bash. Leave out the shell parameter.` };
    }
    return { ok: true, target: { kind: 'posix' } };
  }
  const s = host.shell;
  let kind: WindowsShell = s.windowsDefault;
  if (want === 'powershell' || want === 'pwsh') kind = 'powershell';
  else if (want === 'wsl' || want === 'bash') kind = 'wsl';
  else if (want) return { ok: false, message: `Unknown shell "${want}". On "${host.alias}" use "powershell"${s.wsl ? ' or "wsl"' : ''}.` };
  if (kind === 'wsl' && !s.wsl) {
    if (want) return { ok: false, message: `WSL is not enabled for "${host.alias}" in Gatehouse. Use PowerShell, or ask the user to allow WSL for this host.` };
    // A WSL default with WSL switched off falls back to PowerShell.
    kind = 'powershell';
  }
  return kind === 'wsl'
    ? { ok: true, target: { kind: 'wsl', edition: s.powershell, distro: s.wslDistro || undefined } }
    : { ok: true, target: { kind: 'powershell', edition: s.powershell } };
}

/** The syntax family a shell parses: WSL runs POSIX commands. */
export function syntaxOf(kind: CommandShell): 'posix' | 'powershell' {
  return kind === 'powershell' ? 'powershell' : 'posix';
}

export function editionLabel(edition: PowerShellEdition | undefined): string {
  return edition === 'core' ? 'PowerShell 7' : 'Windows PowerShell 5.1';
}

/** English label; the renderer translates the fixed words. */
export function shellLabel(target: ShellTarget | undefined): string {
  if (!target || target.kind === 'posix') return 'bash';
  if (target.kind === 'powershell') return editionLabel(target.edition);
  return target.distro ? `WSL (${target.distro})` : 'WSL';
}

/** Classifies a command with the parser for its shell's syntax. */
export function assessShellCommand(command: string, kind: CommandShell, opts: ClassifierOptions = {}): CommandAssessment {
  return syntaxOf(kind) === 'powershell' ? assessPowerShellCommand(command, opts) : assessCommand(command, opts);
}
