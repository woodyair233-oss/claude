// Installs test shims that emulate the Windows transport (not PowerShell
// itself) so the real SSH exec path can be exercised on Linux:
//   powershell.exe / pwsh.exe  — decode -EncodedCommand (or stdin), print the
//     PID + code-page marker on stderr, then run the embedded payload as bash
//     so tests can assert behaviour. It reports code page 936 (Chinese
//     Windows) to exercise the GBK decode fallback.
//   wsl.exe       — run `-e <args>` directly (bash is the WSL shell here).
//   taskkill.exe  — kill a process tree by /PID.
// These are plain shell scripts written by the test; nothing is downloaded.

import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Normal template literals: `\\` is one backslash in the file, and `\${` is a
// literal `${` for bash (so JS does not interpolate it).
const POWERSHELL = [
  '#!/bin/bash',
  'enc=""',
  'prev=""',
  'for a in "$@"; do',
  '  case "$prev" in -EncodedCommand|-e|-enc) enc="$a";; esac',
  '  prev="$a"',
  'done',
  'boot=$(printf %s "$enc" | base64 -d 2>/dev/null | iconv -f UTF-16LE -t UTF-8 2>/dev/null)',
  `line=$(printf %s "$boot" | grep -oE "FromBase64String[(]'[A-Za-z0-9+/=]+'" | head -1)`,
  `inner=$(printf %s "$line" | sed -E "s/^FromBase64String[(]'//; s/'$//")`,
  "if [ -z \"$inner\" ]; then inner=$(cat | tr -d '[:space:]'); fi",
  'cmd=$(printf %s "$inner" | base64 -d 2>/dev/null)',
  `printf '\\036GHPID:%s:936\\036' "$$" >&2`,
  'bash -c "$cmd"',
  '',
].join('\n');

const WSL = [
  '#!/bin/bash',
  'args=()',
  'skip=0',
  'for a in "$@"; do',
  '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
  '  case "$a" in',
  '    -d) skip=1;;',
  '    -e) ;;',
  '    *) args+=("$a");;',
  '  esac',
  'done',
  'exec "\\${args[@]}"',
  '',
].join('\n');

const TASKKILL = [
  '#!/bin/bash',
  'pid=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [ "$prev" = "/PID" ]; then pid="$a"; fi',
  '  prev="$a"',
  'done',
  'if [ -n "$pid" ]; then',
  "  pgid=$(ps -o pgid= -p \"$pid\" 2>/dev/null | tr -d ' ')",
  '  [ -n "$pgid" ] && kill -KILL "-$pgid" 2>/dev/null',
  '  pkill -KILL -P "$pid" 2>/dev/null',
  '  kill -KILL "$pid" 2>/dev/null',
  'fi',
  'exit 0',
  '',
].join('\n');

const NAMES = ['powershell.exe', 'pwsh.exe', 'wsl.exe', 'taskkill.exe'];

export function installWinShims(): { dir: string } {
  const bodies: Record<string, string> = { 'powershell.exe': POWERSHELL, 'pwsh.exe': POWERSHELL, 'wsl.exe': WSL, 'taskkill.exe': TASKKILL };
  // /usr/local/bin is on the default PATH that sshd's non-login bash uses, and
  // world-readable so the test user can execute the shims.
  for (const name of NAMES) {
    const p = join('/usr/local/bin', name);
    writeFileSync(p, bodies[name]);
    chmodSync(p, 0o755);
  }
  return { dir: '/usr/local/bin' };
}

export function removeWinShims() {
  for (const name of NAMES) {
    try {
      unlinkSync(join('/usr/local/bin', name));
    } catch {
      /* ignore */
    }
  }
}
