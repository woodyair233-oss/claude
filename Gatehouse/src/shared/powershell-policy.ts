// PowerShell command risk classifier (Windows hosts).
//
// Same philosophy as the POSIX classifier in command-policy.ts: read-only is an
// ALLOWLIST — a command is "read" only when every element of every pipeline is a
// known read-only cmdlet / alias / native tool used with read-only parameters,
// with no writes, redirections, method calls, sub-expressions or script blocks
// that could change state. Everything else needs a human. Danger detection is a
// best-effort denylist on top, used to force approval (or block) even on trusted
// hosts. It covers Windows PowerShell 5.1 and PowerShell 7.

import type { CommandAssessment, Reason, ReasonCode, RiskLevel } from './types';
import { BLOCK_CODES, DANGER_CODES, type ClassifierOptions } from './command-policy';

/** Codes that do not by themselves make a command non-read-only. */
const NEUTRAL_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['sensitive-path', 'sensitive-command']);

// ---------------------------------------------------------------------------
// Default sensitive / system locations on Windows.

export const DEFAULT_WINDOWS_SENSITIVE_PATHS: string[] = [
  '*.pfx', '*.p12', '*.key', '*.pem', '*.jks', '*.keystore', '*.kdbx',
  '*.env', '.env', '.env.*',
  '**/.ssh/id_*', '**/.ssh/*_key',
  '**/.aws/credentials', '**/.azure/**', '**/gcloud/**',
  '**/AppData/**/Login Data', '**/AppData/**/Cookies',
  '**/Microsoft/Credentials/**', '**/Microsoft/Vault/**',
  '*credential*', '*secret*', '*password*',
  '**/System32/config/SAM', '**/System32/config/SECURITY', '**/System32/config/SYSTEM',
];

/** Registry hives and keys that affect the whole machine. */
const SYSTEM_REGISTRY = /^(HKLM:|HKEY_LOCAL_MACHINE|HKCR:|HKEY_CLASSES_ROOT|HKU:|HKEY_USERS|HKLM\\|Registry::HKEY_LOCAL_MACHINE)/i;

/** Windows directories that hold the OS and programs. */
const WINDOWS_SYSTEM_DIR = /^[a-z]:[\\/](windows|winnt|program files( \(x86\))?|programdata|system32|boot|recovery)([\\/]|$)/i;

function toLowerSlash(p: string): string {
  return p.replace(/\\/g, '/').replace(/^["']|["']$/g, '').toLowerCase();
}

export function isWindowsSystemPath(path: string): boolean {
  const p = path.trim();
  if (SYSTEM_REGISTRY.test(p)) return true;
  if (WINDOWS_SYSTEM_DIR.test(p)) return true;
  // A drive root (C:\ or C:\*).
  if (/^[a-z]:[\\/]?\*?$/i.test(p)) return true;
  return false;
}

export function isWindowsSensitivePath(path: string, patterns: string[] = DEFAULT_WINDOWS_SENSITIVE_PATHS): boolean {
  const cand = toLowerSlash(path);
  if (!cand || cand.length > 4096) return false;
  for (const raw of patterns) {
    const t = raw.trim();
    if (!t) continue;
    const rx = windowsGlob(t.toLowerCase());
    try {
      if (new RegExp(rx, 'i').test(cand)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function windowsGlob(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // Match on a path segment boundary unless anchored to a drive.
  return /^[a-z]:/i.test(glob) ? `^${out}$` : `(^|/)${out}$`;
}

// ---------------------------------------------------------------------------
// Aliases → canonical cmdlet (lower-cased lookup).

const ALIASES: Record<string, string> = {
  gc: 'get-content', cat: 'get-content', type: 'get-content',
  gci: 'get-childitem', ls: 'get-childitem', dir: 'get-childitem',
  gi: 'get-item', gp: 'get-itemproperty', gpv: 'get-itempropertyvalue',
  gl: 'get-location', pwd: 'get-location', gps: 'get-process', ps: 'get-process',
  gsv: 'get-service', gm: 'get-member', gcm: 'get-command', gmo: 'get-module',
  gv: 'get-variable', ghy: 'get-history', h: 'get-history', history: 'get-history',
  group: 'group-object', measure: 'measure-object', sort: 'sort-object',
  select: 'select-object', where: 'where-object', '?': 'where-object',
  foreach: 'foreach-object', '%': 'foreach-object', sls: 'select-string',
  compare: 'compare-object', diff: 'compare-object', gu: 'get-unique',
  ft: 'format-table', fl: 'format-list', fw: 'format-wide', fhx: 'format-hex',
  oh: 'out-host', ogv: 'out-gridview', echo: 'write-output', write: 'write-output',
  rvpa: 'resolve-path', cvpa: 'convert-path', epcsv: 'export-csv', ipcsv: 'import-csv',
  // writers / state-changers
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item',
  rmdir: 'remove-item', ri: 'remove-item', rni: 'rename-item', ren: 'rename-item',
  ni: 'new-item', md: 'new-item', mkdir: 'new-item',
  cpi: 'copy-item', cp: 'copy-item', copy: 'copy-item',
  mi: 'move-item', mv: 'move-item', move: 'move-item',
  sc: 'set-content', ac: 'add-content', clc: 'clear-content',
  si: 'set-item', sp: 'set-itemproperty', rp: 'remove-itemproperty', cli: 'clear-item',
  sv: 'set-variable', set: 'set-variable', clv: 'clear-variable', rv: 'remove-variable',
  spps: 'stop-process', kill: 'stop-process', spsv: 'stop-service',
  saps: 'start-process', start: 'start-process', sajb: 'start-job',
  icm: 'invoke-command', iex: 'invoke-expression', ihy: 'invoke-history', r: 'invoke-history',
  iwr: 'invoke-webrequest', curl: 'invoke-webrequest', wget: 'invoke-webrequest',
  irm: 'invoke-restmethod', tee: 'tee-object',
};

// Cmdlets that are read-only with any parameters.
const READ_CMDLETS = new Set<string>([
  'get-content', 'get-childitem', 'get-item', 'get-itemproperty', 'get-itempropertyvalue',
  'get-location', 'get-process', 'get-service', 'get-member', 'get-command', 'get-module',
  'get-variable', 'get-history', 'get-date', 'get-help', 'get-alias', 'get-random', 'get-unique',
  'get-host', 'get-pssession', 'get-psdrive', 'get-psprovider', 'get-formatdata', 'get-typedata',
  'get-computerinfo', 'get-hotfix', 'get-eventlog', 'get-winevent', 'get-counter', 'get-acl',
  'get-authenticodesignature', 'get-filehash', 'get-executionpolicy', 'get-culture', 'get-uiculture',
  'get-timezone', 'get-localuser', 'get-localgroup', 'get-localgroupmember', 'get-netadapter',
  'get-netipaddress', 'get-netipconfiguration', 'get-netroute', 'get-nettcpconnection', 'get-dnsclient',
  'get-dnsclientcache', 'get-netfirewallrule', 'get-netfirewallprofile', 'get-smbshare', 'get-disk',
  'get-volume', 'get-partition', 'get-physicaldisk', 'get-wmiobject', 'get-ciminstance',
  'get-cimclass', 'get-scheduledtask', 'get-scheduledtaskinfo', 'get-job', 'get-package',
  'get-packageprovider', 'get-installedmodule', 'get-installedscript', 'get-appxpackage',
  'get-windowsfeature', 'get-windowsoptionalfeature', 'get-clipboard', 'get-event', 'get-tracesource',
  'get-childitemproperty',
  'select-object', 'select-string', 'where-object', 'sort-object', 'group-object',
  'measure-object', 'compare-object', 'format-table', 'format-list', 'format-wide',
  'format-custom', 'format-hex', 'out-string', 'out-host', 'out-default', 'out-null',
  'write-output', 'write-host', 'write-verbose', 'write-debug', 'write-information', 'write-warning',
  'convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv', 'convertto-xml',
  'convertfrom-stringdata', 'convertto-html', 'convert-path', 'resolve-path', 'split-path', 'join-path',
  'test-path', 'test-connection', 'test-netconnection', 'import-csv', 'import-clixml',
  'measure-command', 'read-host', 'tee-object',
  'select-xml', 'get-content', 'get-childitemproperty',
]);

// Cmdlets that run a script block given as an argument: recurse into their blocks.
const BLOCK_RUNNERS = new Set<string>([
  'foreach-object', 'where-object', 'measure-command', 'invoke-command', 'start-job',
  'start-threadjob', 'register-objectevent', 'trace-command', 'invoke-expression',
]);

// Verbs that a read-only Get-style custom cmdlet might use. Deliberately NOT
// 'format' (Format-Volume), 'export' (Export-PfxCertificate writes a key) or
// 'write' (Write-EventLog): the genuinely read-only Format-*/Out-*/Write-Output
// cmdlets are in READ_CMDLETS by name, so unknown ones fall through to a write.
const READ_VERBS = new Set(['get', 'test', 'measure', 'select', 'compare', 'find', 'search', 'read', 'resolve', 'show', 'out', 'convertto', 'convertfrom', 'trace']);

// Native Windows tools with subcommand-based read/write split.
const NATIVE_READ_ONLY = new Set([
  'whoami', 'hostname', 'ver', 'systeminfo', 'tasklist', 'ipconfig', 'getmac', 'arp', 'nslookup',
  'ping', 'tracert', 'pathping', 'route', 'nbtstat', 'where', 'find', 'findstr', 'more', 'fc',
  'comp', 'tree', 'driverquery', 'query', 'qwinsta', 'whoami.exe', 'cmdkey', 'klist', 'w32tm',
  'typeperf', 'fsutil', 'auditpol', 'gpresult',
]);


// ---------------------------------------------------------------------------
// Tokenizer

type Tok =
  | { t: 'word'; v: string }
  | { t: 'param'; v: string }
  | { t: 'str'; expand: boolean; value: string }
  | { t: 'var'; scope: string; name: string }
  | { t: 'op'; v: '|' | ';' | '&&' | '||' | '&' | ',' | 'nl' }
  | { t: 'redir'; append: boolean; stream: string }
  | { t: 'open'; v: '(' | '{' | '$(' | '@(' | '@{' }
  | { t: 'close'; v: ')' | '}' }
  | { t: 'type'; v: string }
  | { t: 'dcolon' }
  | { t: 'dot' }
  | { t: 'at' };

interface Lexed {
  tokens: Tok[];
  parseError: boolean;
  /** Raw text that was inside "..." or $(...) — expansions handled by rawScan. */
  hadSubexpr: boolean;
  hadMethod: boolean;
  hadHereString: boolean;
}

const WORD_CHAR = /[^\s|;&,(){}'"`#<>\[\]]/;

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

export function tokenizePowerShell(src: string): Lexed {
  const tokens: Tok[] = [];
  let parseError = false;
  let hadSubexpr = false;
  let hadMethod = false;
  let hadHereString = false;
  let i = 0;
  const n = src.length;
  const depth: string[] = [];
  const prevSignificant = (): Tok | undefined => tokens[tokens.length - 1];
  const canFollowMember = (): boolean => {
    const p = prevSignificant();
    return !!p && (p.t === 'var' || p.t === 'str' || p.t === 'type' || (p.t === 'close'));
  };

  while (i < n) {
    const c = src[i];
    // Whitespace (newline is significant between statements).
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\u00a0') {
      i++;
      continue;
    }
    if (c === '\n') {
      tokens.push({ t: 'op', v: 'nl' });
      i++;
      continue;
    }
    // Line comment / block comment.
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '<' && src[i + 1] === '#') {
      const end = src.indexOf('#>', i + 2);
      i = end < 0 ? n : end + 2;
      if (end < 0) parseError = true;
      continue;
    }
    // Here-strings.
    if ((c === '@' && (src[i + 1] === '"' || src[i + 1] === "'"))) {
      const q = src[i + 1];
      const close = '\n' + q + '@';
      const end = src.indexOf(close, i + 2);
      hadHereString = true;
      if (q === '"') hadSubexpr = true; // interpolating here-string
      const value = src.slice(i + 2, end < 0 ? n : end);
      i = end < 0 ? n : end + close.length;
      if (end < 0) parseError = true;
      tokens.push({ t: 'str', expand: q === '"', value });
      continue;
    }
    // Strings. The literal content is captured so path / subcommand checks see
    // through quoting (a quoted path or keyword is not opaque to the classifier).
    if (c === "'" || c === '\u2018' || c === '\u2019') {
      i++;
      let value = '';
      while (i < n) {
        const ch = src[i];
        if (ch === "'" || ch === '\u2018' || ch === '\u2019') {
          if (src[i + 1] === "'" || src[i + 1] === '\u2018' || src[i + 1] === '\u2019') {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += ch;
        i++;
        if (i >= n) parseError = true;
      }
      tokens.push({ t: 'str', expand: false, value });
      continue;
    }
    if (c === '"' || c === '\u201c' || c === '\u201d') {
      i++;
      let expand = false;
      let value = '';
      while (i < n) {
        const ch = src[i];
        if (ch === '`') {
          value += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (ch === '$' && (src[i + 1] === '(' || isIdentStart(src[i + 1]) || src[i + 1] === '{')) {
          expand = true;
          hadSubexpr = true;
        }
        if (ch === '"' || ch === '\u201c' || ch === '\u201d') {
          i++;
          break;
        }
        value += ch;
        i++;
        if (i >= n) parseError = true;
      }
      tokens.push({ t: 'str', expand, value });
      continue;
    }
    // Operators / structure.
    if (c === '|') {
      if (src[i + 1] === '|') {
        tokens.push({ t: 'op', v: '||' });
        i += 2;
      } else {
        tokens.push({ t: 'op', v: '|' });
        i++;
      }
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '&') {
        tokens.push({ t: 'op', v: '&&' });
        i += 2;
      } else {
        tokens.push({ t: 'op', v: '&' });
        i++;
      }
      continue;
    }
    if (c === ';') {
      tokens.push({ t: 'op', v: ';' });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ t: 'op', v: ',' });
      i++;
      continue;
    }
    if (c === '(') {
      depth.push(')');
      tokens.push({ t: 'open', v: '(' });
      i++;
      continue;
    }
    if (c === '{') {
      depth.push('}');
      tokens.push({ t: 'open', v: '{' });
      i++;
      continue;
    }
    if (c === ')' || c === '}') {
      const want = depth.pop();
      if (want !== c) parseError = true;
      tokens.push({ t: 'close', v: c });
      i++;
      continue;
    }
    if (c === '@' && (src[i + 1] === '(' || src[i + 1] === '{')) {
      const open = src[i + 1];
      depth.push(open === '(' ? ')' : '}');
      tokens.push({ t: 'open', v: open === '(' ? '@(' : '@{' });
      i += 2;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      hadSubexpr = true;
      depth.push(')');
      tokens.push({ t: 'open', v: '$(' });
      i += 2;
      continue;
    }
    // Redirection.
    if (c === '>' || ((c === '1' || c === '2' || c === '3' || c === '4' || c === '5' || c === '6' || c === '*') && src[i + 1] === '>')) {
      let stream = '1';
      let j = i;
      if (c !== '>') {
        stream = c;
        j++;
      }
      // j points at '>'
      let append = false;
      j++;
      if (src[j] === '>') {
        append = true;
        j++;
      }
      // `2>&1` style merge is not a file write.
      if (src[j] === '&') {
        // consume the target stream digit
        j++;
        if (/\d/.test(src[j])) j++;
        i = j;
        continue;
      }
      tokens.push({ t: 'redir', append, stream });
      i = j;
      continue;
    }
    // Variables: $x, ${x}, $env:X, $global:X, @x (splat).
    if (c === '$' || (c === '@' && isIdentStart(src[i + 1]))) {
      i++;
      let scope = '';
      let name = '';
      if (src[i] === '{') {
        const end = src.indexOf('}', i + 1);
        name = src.slice(i + 1, end < 0 ? n : end);
        i = end < 0 ? n : end + 1;
      } else {
        let start = i;
        while (i < n && /[A-Za-z0-9_:]/.test(src[i])) i++;
        const raw = src.slice(start, i);
        const colon = raw.indexOf(':');
        if (colon >= 0) {
          scope = raw.slice(0, colon).toLowerCase();
          name = raw.slice(colon + 1);
        } else name = raw;
      }
      tokens.push({ t: 'var', scope, name });
      continue;
    }
    // Type literal / attribute: [Namespace.Type]
    if (c === '[') {
      let d = 1;
      let j = i + 1;
      while (j < n && d > 0) {
        if (src[j] === '[') d++;
        else if (src[j] === ']') d--;
        j++;
      }
      if (d !== 0) parseError = true;
      tokens.push({ t: 'type', v: src.slice(i + 1, Math.max(i + 1, j - 1)) });
      i = j;
      continue;
    }
    if (c === ']') {
      // stray close bracket
      i++;
      continue;
    }
    // Member access.
    if (c === ':' && src[i + 1] === ':') {
      tokens.push({ t: 'dcolon' });
      hadMethod = true; // static member access; refined later
      i += 2;
      continue;
    }
    if (c === '.' && (canFollowMember() || prevSignificant()?.t === 'word')) {
      // Could be member access or a word like "a.txt". Treat as member access
      // only when it directly follows a value token or a word and is followed
      // by an identifier; a space before '.' is dot-sourcing (call).
      if (isIdentStart(src[i + 1] ?? '') || src[i + 1] === '_') {
        tokens.push({ t: 'dot' });
        i++;
        continue;
      }
    }
    // Parameter: -Name (not a negative number).
    if (c === '-' && isIdentStart(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_?]/.test(src[j])) j++;
      tokens.push({ t: 'param', v: src.slice(i + 1, j).toLowerCase() });
      i = j;
      // -Name:value keeps the colon+value as a following word.
      continue;
    }
    // Bareword (command name, argument, path, number, native exe).
    {
      let j = i;
      let buf = '';
      while (j < n) {
        const ch = src[j];
        if (ch === '`') {
          buf += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (WORD_CHAR.test(ch) && ch !== '.') {
          buf += ch;
          j++;
          continue;
        }
        if (ch === '.') {
          // keep dots that are part of a filename/number (surrounded by word chars)
          if (WORD_CHAR.test(src[j + 1] ?? ' ') && src[j + 1] !== '.') {
            buf += ch;
            j++;
            continue;
          }
          break;
        }
        break;
      }
      if (j === i) {
        // Unconsumed char: skip to avoid an infinite loop.
        i++;
        continue;
      }
      // A word immediately followed by '(' is a function/method call.
      if (src[j] === '(') hadMethod = hadMethod || tokens.length > 0;
      tokens.push({ t: 'word', v: buf });
      i = j;
    }
  }
  if (depth.length) parseError = true;
  return { tokens, parseError, hadSubexpr, hadMethod, hadHereString };
}

// ---------------------------------------------------------------------------
// Analysis

/** Grouping-recursion ceiling: deep enough for any real command, shallow enough to bound work. */
const MAX_DEPTH = 24;

interface Ctx {
  reasons: Reason[];
  programs: string[];
  opts: ClassifierOptions;
  sensitivePatterns: string[];
}

function push(ctx: Ctx, code: ReasonCode, detail?: string) {
  if (ctx.reasons.some((r) => r.code === code && r.detail === detail)) return;
  ctx.reasons.push(detail === undefined ? { code } : { code, detail });
}

function canonical(word: string): string {
  let w = word.toLowerCase();
  let wasExe = false;
  if (w.endsWith('.exe') || w.endsWith('.cmd') || w.endsWith('.bat') || w.endsWith('.ps1')) {
    wasExe = !w.endsWith('.ps1');
    w = w.slice(0, w.lastIndexOf('.'));
  }
  const slash = Math.max(w.lastIndexOf('\\'), w.lastIndexOf('/'));
  if (slash >= 0) w = w.slice(slash + 1);
  // A name written with .exe/.cmd/.bat is a native tool, never a PowerShell alias.
  return wasExe ? w : ALIASES[w] ?? w;
}

/** The lower-cased base name before any alias resolution (for native-tool rules). */
function baseName(word: string): string {
  let w = word.toLowerCase();
  if (w.endsWith('.exe') || w.endsWith('.cmd') || w.endsWith('.bat') || w.endsWith('.ps1')) w = w.slice(0, w.lastIndexOf('.'));
  const slash = Math.max(w.lastIndexOf('\\'), w.lastIndexOf('/'));
  if (slash >= 0) w = w.slice(slash + 1);
  return w;
}

const PURE_METHODS = new Set([
  'tostring', 'trim', 'trimstart', 'trimend', 'substring', 'split', 'replace', 'toupper', 'tolower',
  'toupperinvariant', 'tolowerinvariant', 'padleft', 'padright', 'contains', 'startswith', 'endswith',
  'indexof', 'lastindexof', 'gettype', 'equals', 'compareto', 'clone', 'getenumerator', 'containskey',
  'where', 'foreach', 'count', 'length', 'insert', 'format', 'join', 'tochararray', 'normalize',
]);

const DANGER_METHODS = /(delete|remove|kill|stop|dispose|create|write|move|copy|append|truncate|format|clear|invoke|start|setvalue|deletevalue|deletekey|setaccesscontrol|encrypt|decrypt|downloadstring|downloadfile|downloaddata|openwrite)/i;
const DANGER_TYPES = /(system\.)?(io\.(file|directory|streamwriter|filestream)|diagnostics\.process|net\.webclient|net\.sockets|management\.automation|microsoft\.win32\.registry|security\.|runtime\.interopservices|reflection\.assembly|activator|appdomain|environment)/i;

/** Finds the matching close for an 'open' token starting at index `from` (the open). */
function matchClose(tokens: Tok[], from: number): number {
  let d = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'open') d++;
    else if (t.t === 'close') {
      d--;
      if (d === 0) return i;
    }
  }
  return tokens.length;
}

function analyzeCommandPipelineElement(ctx: Ctx, tokens: Tok[], depth: number) {
  if (!tokens.length) return;
  let idx = 0;
  // Skip a leading assignment: $x = …  / $env:x = … (the latter changes env).
  if (tokens[0].t === 'var' && (tokens[1]?.t === 'word' && /^(\+|-|\*|\/|%)?=$/.test((tokens[1] as { v: string }).v))) {
    if (tokens[0].scope === 'env') push(ctx, 'env-assignment', `$env:${tokens[0].name}`);
    idx = 2;
    // The right-hand side is analysed as its own element.
    analyzeCommandPipelineElement(ctx, tokens.slice(idx), depth);
    return;
  }
  // Call operators: & <thing> / . <thing>
  let t = tokens[idx];
  if (t && t.t === 'op' && t.v === '&') {
    const next = tokens[idx + 1];
    if (next && next.t === 'word') {
      push(ctx, 'interpreter', `& ${next.v}`);
    } else {
      push(ctx, 'variable-command', '& (…)');
    }
    idx++;
    t = tokens[idx];
  }
  // A sub-expression / script-block / type in command position. A bare leading
  // variable ($x arg) is an expression in PowerShell, not a command execution —
  // only the call operator (& $x) runs it, so a plain var is not flagged here.
  if (t && (t.t === 'open' || t.t === 'var' || t.t === 'type')) {
    if (t.t === 'type') {
      // [Type]::Method(...) in command position: danger only for a risky type
      // ([IO.File]::Delete), otherwise needs approval ([Math]::Max is benign).
      push(ctx, DANGER_TYPES.test(t.v.replace(/\s/g, '')) ? 'method-call' : 'modifying-args', t.v.slice(0, 60));
    }
    // still scan the remaining tokens for blocks / methods / paths
    scanArgs(ctx, tokens.slice(idx), depth);
    return;
  }
  if (!t || t.t !== 'word') {
    scanArgs(ctx, tokens.slice(idx), depth);
    return;
  }
  const cmd = canonical(t.v);
  const raw = baseName(t.v);
  ctx.programs.push(cmd);
  const args = tokens.slice(idx + 1);

  // A bare name that is both a PowerShell alias and a native tool (e.g. `sc` →
  // Set-Content in 5.1, but sc.exe in PowerShell 7) must still face its native
  // danger rule, so the alias cannot be used to downgrade the risk.
  if (raw !== cmd && NATIVE_RULES[raw]) NATIVE_RULES[raw](ctx, args);

  if (cmd === 'invoke-expression') {
    push(ctx, 'interpreter', 'Invoke-Expression');
  } else if (cmd === 'powershell' || cmd === 'pwsh' || cmd === 'cmd' || cmd === 'wscript' || cmd === 'cscript' || cmd === 'mshta' || cmd === 'rundll32' || cmd === 'regsvr32' || cmd === 'conhost') {
    push(ctx, 'interpreter', cmd); // nested shells / script hosts run arbitrary code
  } else if (cmd === 'invoke-command') {
    push(ctx, 'interpreter', 'Invoke-Command');
  } else if (cmd === 'invoke-webrequest' || cmd === 'invoke-restmethod') {
    push(ctx, 'network-tool', cmd);
    if (hasParam(args, 'outfile') || hasParam(args, 'o')) push(ctx, 'redirect-write', `${cmd} -OutFile`);
  } else if (cmd === 'start-process' || cmd === 'start-job' || cmd === 'start-threadjob') {
    push(ctx, 'interpreter', cmd);
  } else if (cmd === 'new-object') {
    const type = args.find((a) => a.t === 'word');
    push(ctx, 'modifying-args', `New-Object ${type && type.t === 'word' ? type.v : ''}`.trim());
  } else if (cmd === 'set-content' || cmd === 'add-content' || cmd === 'out-file' || cmd === 'export-csv' || cmd === 'export-clixml' || cmd === 'set-item' || cmd === 'new-item' || cmd === 'tee-object') {
    push(ctx, 'redirect-write', cmd);
    checkWritePaths(ctx, args);
  } else if (cmd === 'set-itemproperty' || cmd === 'new-itemproperty' || cmd === 'remove-itemproperty' || cmd === 'clear-itemproperty') {
    checkRegistryWrite(ctx, args, cmd);
  } else if (cmd === 'remove-item' || cmd === 'clear-content' || cmd === 'clear-item' || cmd === 'rename-item' || cmd === 'move-item' || cmd === 'copy-item') {
    analyzeRemove(ctx, cmd, args);
  } else if (BLOCK_RUNNERS.has(cmd)) {
    if (cmd === 'where-object' || cmd === 'foreach-object' || cmd === 'measure-command') {
      // Benign iterators, but they run any script block / expression passed to them.
      if (cmd === 'foreach-object') push(ctx, 'modifying-args', 'ForEach-Object');
    } else push(ctx, 'interpreter', cmd);
  } else if (READ_CMDLETS.has(cmd)) {
    if (cmd === 'tee-object') {
      push(ctx, 'redirect-write', 'Tee-Object');
      checkWritePaths(ctx, args);
    }
    // read-only; still scan args for sensitive paths and blocks
  } else if (NATIVE_READ_ONLY.has(cmd)) {
    analyzeNative(ctx, cmd, args);
  } else if (isReadVerbCmdlet(cmd)) {
    // Unknown Get-*/Test-* style cmdlet: treat as read-only but surface it.
  } else {
    analyzeNative(ctx, cmd, args);
  }

  scanArgs(ctx, args, depth);
}

function isReadVerbCmdlet(cmd: string): boolean {
  const dash = cmd.indexOf('-');
  if (dash <= 0) return false;
  return READ_VERBS.has(cmd.slice(0, dash));
}

function hasParam(args: Tok[], name: string): boolean {
  return args.some((a) => a.t === 'param' && (a.v === name || a.v.startsWith(name)));
}

/** First string/word arguments (non-parameter), as plain strings where known. */
function positionalWords(args: Tok[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.t === 'param') {
      // skip its value word if any (handled coarsely)
      continue;
    }
    if (a.t === 'word') out.push(a.v);
    else if (a.t === 'str') out.push(a.value); // a quoted keyword (net "user" …) is still a positional
  }
  return out;
}

function analyzeRemove(ctx: Ctx, cmd: string, args: Tok[]) {
  const recurse = hasParam(args, 'recurse') || hasParam(args, 'r');
  const force = hasParam(args, 'force');
  const paths = pathArgs(args);
  const catastrophic = paths.some((p) => isWindowsSystemPath(p) || /^[a-z]:[\\/]?\*?$/i.test(p) || /^[\\/]$/.test(p));
  if (cmd === 'remove-item' || cmd === 'clear-item' || cmd === 'clear-content') {
    if (catastrophic && recurse) push(ctx, 'root-delete', paths.join(' '));
    else if (recurse || force) push(ctx, 'recursive-delete', `${cmd}${recurse ? ' -Recurse' : ''}${force ? ' -Force' : ''}`);
    else push(ctx, 'delete', cmd);
  }
  for (const p of paths) {
    if (isWindowsSystemPath(p)) push(ctx, 'system-file-write', p);
    if (SYSTEM_REGISTRY.test(p)) push(ctx, 'registry-system', p);
  }
  if (cmd === 'move-item' || cmd === 'copy-item' || cmd === 'rename-item') {
    push(ctx, 'modifying-args', cmd);
    for (const p of paths) if (isWindowsSystemPath(p)) push(ctx, 'system-file-write', p);
  }
}

function checkWritePaths(ctx: Ctx, args: Tok[]) {
  for (const p of pathArgs(args)) {
    if (isWindowsSystemPath(p)) push(ctx, 'system-file-write', p);
    if (SYSTEM_REGISTRY.test(p)) push(ctx, 'registry-system', p);
  }
}

function checkRegistryWrite(ctx: Ctx, args: Tok[], cmd: string) {
  const paths = pathArgs(args);
  push(ctx, 'redirect-write', cmd);
  for (const p of paths) {
    if (SYSTEM_REGISTRY.test(p)) push(ctx, 'registry-system', p);
    else if (isWindowsSystemPath(p)) push(ctx, 'system-file-write', p);
  }
}

/** Path-looking positional/-Path arguments as plain strings (quoted or bare). */
function pathArgs(args: Tok[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.t === 'word') out.push(a.v);
    else if (a.t === 'str') out.push(a.value);
    else if (a.t === 'param' && (a.v === 'path' || a.v === 'literalpath' || a.v === 'destination' || a.v === 'filepath' || a.v === 'outfile')) {
      const nv = args[i + 1];
      if (nv && nv.t === 'word') out.push(nv.v);
      else if (nv && nv.t === 'str') out.push(nv.value);
    }
  }
  return out;
}

const NATIVE_RULES: Record<string, (ctx: Ctx, args: Tok[]) => void> = {
  reg: (ctx, args) => {
    const sub = positionalWords(args)[0]?.toLowerCase();
    if (sub && ['delete', 'add', 'import', 'load', 'unload', 'restore', 'copy'].includes(sub)) {
      const target = positionalWords(args)[1] ?? '';
      if (SYSTEM_REGISTRY.test(target)) push(ctx, 'registry-system', `reg ${sub}`);
      else push(ctx, 'redirect-write', `reg ${sub}`);
    }
  },
  net: (ctx, args) => {
    const p = positionalWords(args).map((w) => w.toLowerCase());
    if (p[0] === 'user' && (p.length > 2 || hasParam(args, 'add') || p.includes('/add') || p.includes('/delete'))) push(ctx, 'user-account', 'net user');
    if (p[0] === 'localgroup' && (p.includes('/add') || p.includes('/delete'))) push(ctx, 'user-account', 'net localgroup');
    if (p[0] === 'stop' || p[0] === 'start') push(ctx, 'kill-processes', `net ${p[0]}`);
  },
  netsh: (ctx, args) => {
    const p = positionalWords(args).map((w) => w.toLowerCase());
    if (p.includes('advfirewall') || p.includes('firewall')) {
      if (!p.includes('show')) push(ctx, 'firewall', 'netsh firewall');
    }
  },
  sc: (ctx, args) => {
    const sub = positionalWords(args).find((w) => !w.startsWith('\\'))?.toLowerCase();
    if (sub && ['delete', 'stop', 'config', 'create', 'failure'].includes(sub)) push(ctx, 'kill-processes', `sc ${sub}`);
  },
  taskkill: (ctx) => push(ctx, 'kill-processes', 'taskkill'),
  shutdown: (ctx, args) => {
    const p = positionalWords(args).map((w) => w.toLowerCase());
    if (!p.includes('/a') && !hasParam(args, 'a')) push(ctx, 'power', 'shutdown');
  },
  bcdedit: (ctx) => push(ctx, 'boot-config', 'bcdedit'),
  diskpart: (ctx) => push(ctx, 'disk-destroy', 'diskpart'),
  format: (ctx) => push(ctx, 'disk-destroy', 'format'),
  cipher: (ctx, args) => {
    if (hasParam(args, 'w') || positionalWords(args).some((w) => /^\/w/i.test(w))) push(ctx, 'disk-destroy', 'cipher /w');
  },
  takeown: (ctx) => push(ctx, 'permissions-recursive', 'takeown'),
  icacls: (ctx, args) => {
    if (positionalWords(args).some((w) => /^\/(grant|deny|remove|setowner|reset)/i.test(w))) push(ctx, 'permissions-recursive', 'icacls');
  },
  cacls: (ctx) => push(ctx, 'permissions-recursive', 'cacls'),
  attrib: (ctx, args) => {
    for (const p of positionalWords(args)) if (isWindowsSystemPath(p)) push(ctx, 'system-file-write', p);
  },
  vssadmin: (ctx, args) => {
    if (positionalWords(args)[0]?.toLowerCase() === 'delete') push(ctx, 'disk-destroy', 'vssadmin delete');
  },
  wbadmin: (ctx, args) => {
    if (positionalWords(args)[0]?.toLowerCase() === 'delete') push(ctx, 'disk-destroy', 'wbadmin delete');
  },
  del: (ctx) => push(ctx, 'delete', 'del'),
  erase: (ctx) => push(ctx, 'delete', 'del'),
  rd: (ctx, args) => (hasParam(args, 's') || positionalWords(args).some((w) => /^\/s/i.test(w)) ? push(ctx, 'recursive-delete', 'rd /s') : push(ctx, 'delete', 'rd')),
  rmdir: (ctx, args) => (positionalWords(args).some((w) => /^\/s/i.test(w)) ? push(ctx, 'recursive-delete', 'rmdir /s') : push(ctx, 'delete', 'rmdir')),
  powercfg: (ctx) => push(ctx, 'firewall', 'powercfg'),
  reagentc: (ctx) => push(ctx, 'boot-config', 'reagentc'),
  sfc: (ctx) => push(ctx, 'system-file-write', 'sfc'),
  dism: (ctx, args) => {
    if (positionalWords(args).some((w) => /\/(add|remove|disable|enable|restore|cleanup)/i.test(w))) push(ctx, 'system-file-write', 'dism');
  },
  wevtutil: (ctx, args) => {
    const sub = positionalWords(args)[0]?.toLowerCase();
    if (sub === 'cl' || sub === 'clear-log' || sub === 'sl' || sub === 'set-log') push(ctx, 'history-tamper', `wevtutil ${sub}`);
  },
  certutil: (ctx, args) => {
    const w = positionalWords(args).map((x) => x.toLowerCase());
    if (w.some((x) => x === '-urlcache' || x === '-verifyctl' || x === '-urlfetch')) push(ctx, 'download-exec', 'certutil -urlcache');
    else if (w.some((x) => x === '-decode' || x === '-encode' || x === '-decodehex')) push(ctx, 'redirect-write', 'certutil -decode');
  },
};

function analyzeNative(ctx: Ctx, cmd: string, args: Tok[]) {
  const rule = NATIVE_RULES[cmd];
  if (rule) {
    rule(ctx, args);
    return;
  }
  if (NATIVE_READ_ONLY.has(cmd)) return;
  // Uninstall / package managers.
  if (cmd === 'choco' || cmd === 'winget' || cmd === 'scoop') {
    const sub = positionalWords(args)[0]?.toLowerCase();
    if (sub && ['uninstall', 'remove', 'rm'].includes(sub)) push(ctx, 'package-remove', `${cmd} ${sub}`);
    else if (sub && ['install', 'upgrade', 'update'].includes(sub)) push(ctx, 'download-exec', `${cmd} ${sub}`);
    return;
  }
  if (cmd === 'uninstall-module' || cmd === 'uninstall-package' || cmd === 'remove-windowsfeature' || cmd === 'remove-appxpackage') {
    push(ctx, 'package-remove', cmd);
    return;
  }
  if (cmd === 'stop-computer' || cmd === 'restart-computer') {
    push(ctx, 'power', cmd);
    return;
  }
  if (cmd === 'stop-service' || cmd === 'suspend-service' || cmd === 'restart-service' || cmd === 'set-service') {
    push(ctx, 'kill-processes', cmd);
    return;
  }
  if (cmd === 'stop-process') {
    push(ctx, 'kill-processes', 'Stop-Process');
    return;
  }
  if (cmd === 'set-executionpolicy') {
    push(ctx, 'security-disable', 'Set-ExecutionPolicy');
    return;
  }
  if (cmd === 'set-mppreference' || cmd === 'add-mppreference' || cmd === 'remove-mppreference') {
    push(ctx, 'security-disable', cmd);
    return;
  }
  if (cmd === 'new-localuser' || cmd === 'remove-localuser' || cmd === 'set-localuser' || cmd === 'add-localgroupmember' || cmd === 'remove-localgroupmember' || cmd === 'new-localgroup') {
    push(ctx, 'user-account', cmd);
    return;
  }
  if (cmd === 'new-netfirewallrule' || cmd === 'set-netfirewallrule' || cmd === 'remove-netfirewallrule' || cmd === 'set-netfirewallprofile' || cmd === 'disable-netadapter') {
    push(ctx, 'firewall', cmd);
    return;
  }
  if (cmd === 'format-volume' || cmd === 'clear-disk' || cmd === 'initialize-disk' || cmd === 'remove-partition' || cmd === 'reset-physicaldisk') {
    push(ctx, 'disk-destroy', cmd);
    return;
  }
  if (cmd === 'clear-eventlog' || cmd === 'remove-eventlog' || cmd === 'wevtutil') {
    if (cmd === 'wevtutil') {
      if (positionalWords(args)[0]?.toLowerCase() === 'cl') push(ctx, 'history-tamper', 'wevtutil cl');
      return;
    }
    push(ctx, 'history-tamper', cmd);
    return;
  }
  if (cmd === 'clear-history') {
    push(ctx, 'history-tamper', 'Clear-History');
    return;
  }
  if (cmd === 'register-scheduledtask' || cmd === 'unregister-scheduledtask' || cmd === 'set-scheduledtask' || cmd === 'schtasks') {
    if (cmd === 'schtasks') {
      const w = positionalWords(args).map((x) => x.toLowerCase());
      if (w.some((x) => /\/(create|delete|change|run)/.test(x))) push(ctx, 'modifying-args', 'schtasks');
      return;
    }
    push(ctx, 'modifying-args', cmd);
    return;
  }
  if (cmd === 'set-location' || cmd === 'push-location' || cmd === 'pop-location') return; // cd — harmless
  if (cmd === 'where-object' || cmd === 'foreach-object') return;
  // A cmdlet we do not know: treat its verb.
  const dash = cmd.indexOf('-');
  if (dash > 0) {
    const verb = cmd.slice(0, dash);
    if (READ_VERBS.has(verb)) return;
    if (['set', 'new', 'add', 'update', 'install', 'import', 'register', 'enable', 'disable', 'rename', 'move', 'copy', 'send', 'invoke', 'push', 'write', 'edit', 'export', 'format', 'clear', 'reset', 'restart', 'start', 'mount', 'dismount', 'convert'].includes(verb)) {
      push(ctx, 'modifying-args', cmd);
      return;
    }
    push(ctx, 'unknown-program', cmd);
    return;
  }
  // A native executable we do not know.
  push(ctx, 'unknown-program', cmd);
}

/** Scans argument tokens for script blocks (recurse), method calls, and paths. */
function scanArgs(ctx: Ctx, args: Tok[], depth: number) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.t === 'open') {
      // Groupings that execute a statement list — ( ), { }, $( ) and the
      // array-subexpression @( ) — are recursed, so a destructive command can
      // never hide inside one (the @() bypass). A @{ } hashtable literal is
      // key/value pairs, not a statement list, so its tokens are scanned flat
      // (sensitive paths still checked) rather than misread as commands.
      if (a.v === '@{') continue;
      const close = matchClose(args, i);
      const inner = args.slice(i + 1, close);
      if (depth < MAX_DEPTH) analyzeStatements(ctx, inner, depth + 1);
      else if (inner.length) push(ctx, 'parse-error', 'nesting too deep'); // too deep to prove read-only → not read
      i = close;
      continue;
    }
    if (a.t === 'dot') {
      // .Member — a method call when followed by '(' further on.
      const name = args[i + 1];
      const after = args[i + 2];
      if (name && name.t === 'word') {
        const isCall = after && after.t === 'open' && after.v === '(';
        if (isCall) {
          const m = name.v.toLowerCase();
          if (DANGER_METHODS.test(m)) push(ctx, 'method-call', `.${name.v}()`);
          else if (!PURE_METHODS.has(m)) push(ctx, 'modifying-args', `.${name.v}()`);
        }
      }
      continue;
    }
    if (a.t === 'dcolon') {
      const name = args[i + 1];
      if (name && name.t === 'word') {
        // A static call is dangerous only on a risky type (checked via the 'type' token);
        // otherwise it still needs approval.
        push(ctx, DANGER_METHODS.test(name.v.toLowerCase()) ? 'method-call' : 'modifying-args', `::${name.v}`);
      }
      continue;
    }
    if (a.t === 'type') {
      if (DANGER_TYPES.test(a.v.replace(/\s/g, ''))) push(ctx, 'method-call', `[${a.v.slice(0, 40)}]`);
      continue;
    }
    if (a.t === 'word' && isWindowsSensitivePath(a.v, ctx.sensitivePatterns)) push(ctx, 'sensitive-path', a.v);
    // A quoted path is still a path (Get-Content 'C:\…\.aws\credentials').
    if (a.t === 'str' && a.value && isWindowsSensitivePath(a.value, ctx.sensitivePatterns)) push(ctx, 'sensitive-path', a.value);
    // -EncodedCommand / -Command carry hidden code (tokenized as a param, hyphen stripped).
    if (a.t === 'param' && (a.v === 'encodedcommand' || a.v === 'enc' || a.v === 'e' || a.v === 'command' || a.v === 'c')) push(ctx, 'interpreter', `-${a.v}`);
    if (a.t === 'var' && a.scope === 'env') push(ctx, 'sensitive-command', `$env:${a.name}`);
  }
}

/** Splits a token run into pipeline elements at top-level `|`. */
function analyzePipeline(ctx: Ctx, tokens: Tok[], depth: number) {
  let d = 0;
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    const t = tokens[i];
    if (!t) {
      analyzeCommandPipelineElement(ctx, tokens.slice(start, i), depth);
      break;
    }
    if (t.t === 'open') d++;
    else if (t.t === 'close') d--;
    else if (d === 0 && t.t === 'op' && t.v === '|') {
      analyzeCommandPipelineElement(ctx, tokens.slice(start, i), depth);
      start = i + 1;
    }
  }
}

/** Splits into statements at top-level `;`, newlines and `&&` / `||`. */
function analyzeStatements(ctx: Ctx, tokens: Tok[], depth: number) {
  let d = 0;
  let start = 0;
  const flush = (end: number) => {
    const slice = tokens.slice(start, end).filter((t) => !(t.t === 'op' && t.v === 'nl'));
    if (slice.length) analyzePipeline(ctx, slice, depth);
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'open') d++;
    else if (t.t === 'close') d--;
    else if (d === 0 && t.t === 'op' && (t.v === ';' || t.v === 'nl' || t.v === '&&' || t.v === '||')) {
      flush(i);
      start = i + 1;
    } else if (d === 0 && t.t === 'op' && t.v === '&') {
      // trailing `&` starts a background job in PS 7.
      push(ctx, 'background', '&');
    }
  }
  flush(tokens.length);
}

// ---------------------------------------------------------------------------
// Raw regex scan (defense in depth, mirrors the POSIX rawScan).

const PS_RAW_DANGER: { rx: RegExp; code: ReasonCode; detail: string }[] = [
  { rx: /\b(iex|invoke-expression)\b[\s(]+.*(iwr|irm|invoke-web|invoke-rest|downloadstring|net\.webclient)/is, code: 'download-exec', detail: 'download | iex' },
  { rx: /(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^\n|]*\|\s*(iex|invoke-expression)/is, code: 'download-exec', detail: 'download | iex' },
  { rx: /downloadstring\s*\(/i, code: 'download-exec', detail: 'WebClient.DownloadString' },
  // A space (or any non-word char) precedes a switch, so match on that boundary, not \b.
  { rx: /(?:^|\brm\b|remove-item|ri\b|del\b|erase\b|rd\b)[^\n]*(?:^|\s)-(?:recurse|r)\b[^\n]*(?:^|\s)-(?:force|f)\b|(?:^|\s)-(?:force|f)\b[^\n]*(?:^|\s)-(?:recurse|r)\b/i, code: 'recursive-delete', detail: 'Remove-Item -Recurse -Force' },
  { rx: /(?:remove-item|\brm\b|ri\b|del\b|erase\b|\brd\b)[^\n]*['"]?[a-z]:[\\/]?['"]?(?:\s|$)[^\n]*(?:^|\s)-(?:recurse|r)\b/i, code: 'root-delete', detail: 'Remove drive root' },
  { rx: /\bformat-volume\b|\bclear-disk\b|\bformat(\.com)?\s+[a-z]:/i, code: 'disk-destroy', detail: 'format / Clear-Disk' },
  { rx: /\bset-executionpolicy\b[^\n]*\b(unrestricted|bypass)\b/i, code: 'security-disable', detail: 'Set-ExecutionPolicy Bypass' },
  { rx: /set-mppreference[^\n]*-disable|add-mppreference[^\n]*-exclusion|disablerealtimemonitoring\s*\$?true/i, code: 'security-disable', detail: 'disable Defender' },
  { rx: /\bstop-computer\b|\brestart-computer\b|\bshutdown(\.exe)?\s+\/[rs]\b/i, code: 'power', detail: 'shutdown' },
  { rx: /\bbcdedit\b/i, code: 'boot-config', detail: 'bcdedit' },
  { rx: /(^|[\s;])(reg(\.exe)?)\s+(delete|add)\b[^\n]*hk(lm|ey_local_machine)/i, code: 'registry-system', detail: 'reg delete/add HKLM' },
  { rx: /set-itemproperty[^\n]*hklm:|new-itemproperty[^\n]*hklm:/i, code: 'registry-system', detail: 'HKLM registry write' },
  { rx: /while\s*\(\s*\$?(true|1)\s*\)\s*\{[^}]*(start-process|start-job|new-object|iex|invoke)/i, code: 'fork-bomb', detail: 'infinite spawn loop' },
  { rx: /\bvssadmin\s+delete\b|\bwbadmin\s+delete\b/i, code: 'disk-destroy', detail: 'delete backups / shadows' },
];

function rawScan(ctx: Ctx, command: string) {
  for (const { rx, code, detail } of PS_RAW_DANGER) if (rx.test(command)) push(ctx, code, detail);
  for (const src of ctx.opts.dangerPatterns ?? []) {
    try {
      if (src.trim() && new RegExp(src, 'i').test(command)) push(ctx, 'custom-danger', src);
    } catch {
      /* ignore */
    }
  }
  for (const src of ctx.opts.blockPatterns ?? []) {
    try {
      if (src.trim() && new RegExp(src, 'i').test(command)) push(ctx, 'custom-block', src);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------

export function assessPowerShellCommand(command: string, opts: ClassifierOptions = {}): CommandAssessment {
  const ctx: Ctx = {
    reasons: [],
    programs: [],
    opts,
    sensitivePatterns: opts.sensitivePaths?.length ? opts.sensitivePaths : DEFAULT_WINDOWS_SENSITIVE_PATHS,
  };
  const trimmed = command.trim();
  if (!trimmed) return { risk: 'block', sensitive: false, reasons: [{ code: 'empty' }], programs: [], simple: false };

  const lexed = tokenizePowerShell(trimmed);
  if (lexed.parseError) push(ctx, 'parse-error');
  if (lexed.hadSubexpr) push(ctx, 'substitution');
  analyzeStatements(ctx, lexed.tokens, 0);
  // Top-level redirections.
  for (const t of lexed.tokens) if (t.t === 'redir') push(ctx, 'redirect-write', `${t.stream}>${t.append ? '>' : ''}`);
  rawScan(ctx, trimmed);

  const codes = ctx.reasons.map((r) => r.code);
  let risk: RiskLevel = 'read';
  if (codes.some((c) => BLOCK_CODES.has(c))) risk = 'block';
  else if (codes.some((c) => DANGER_CODES.has(c))) risk = 'danger';
  else if (codes.some((c) => !NEUTRAL_CODES.has(c))) risk = 'write';

  // "simple" (eligible for allow-patterns): one pipeline element, no operators,
  // redirects, blocks, sub-expressions or method calls.
  const hasOps = lexed.tokens.some((t) => (t.t === 'op' && t.v !== 'nl') || t.t === 'redir' || t.t === 'open');
  const newlineStmts = lexed.tokens.filter((t) => t.t === 'op' && t.v === 'nl').length;
  const simple = !hasOps && !lexed.hadSubexpr && !lexed.hadMethod && !lexed.parseError && newlineStmts === 0;

  return {
    risk,
    sensitive: codes.some((c) => NEUTRAL_CODES.has(c)),
    reasons: ctx.reasons,
    programs: [...new Set(ctx.programs)],
    simple,
  };
}
