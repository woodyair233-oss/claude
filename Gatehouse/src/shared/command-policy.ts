// Command risk classifier.
//
// Read-only detection is an ALLOWLIST: a command is "read" only when every
// program in it is a known read-only program used with read-only arguments,
// and the command line has no writes, substitutions or background jobs.
// Everything else needs a human (or a trusted host). Danger detection is a
// best-effort DENYLIST on top, used to force approval (or block) even on
// trusted hosts. Neither replaces the human approval step.

import type { CommandAssessment, Reason, ReasonCode, RiskLevel } from './types';
import { normalizeCommand, parseShell, type Redirect, type Segment } from './shell-parse';

export interface ClassifierOptions {
  /** Extra program names (or "program subcommand" prefixes) the user treats as read-only. */
  extraReadOnly?: string[];
  /** User regexes (case-insensitive) that force approval. */
  dangerPatterns?: string[];
  /** User regexes (case-insensitive) that are always refused. */
  blockPatterns?: string[];
  /** Glob patterns of credential/secret files. */
  sensitivePaths?: string[];
}

export const BLOCK_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'root-delete',
  'fork-bomb',
  'device-overwrite',
  'custom-block',
]);

export const DANGER_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'recursive-delete',
  'disk-destroy',
  'power',
  'firewall',
  'ssh-lockout',
  'user-account',
  'permissions-recursive',
  'kill-processes',
  'package-remove',
  'container-destroy',
  'database-destroy',
  'git-destructive',
  'infra-destroy',
  'history-tamper',
  'system-file-write',
  'crontab-remove',
  'download-exec',
  'custom-danger',
]);

/** Codes that do not by themselves make a command non-read-only. */
const NEUTRAL_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['sensitive-path', 'sensitive-command']);

export const DEFAULT_SENSITIVE_PATHS: string[] = [
  '/etc/shadow',
  '/etc/shadow-',
  '/etc/gshadow',
  '/etc/sudoers',
  '/etc/sudoers.d/**',
  '/etc/ssh/ssh_host_*key',
  '~/.ssh/id_*',
  '~/.ssh/*_key',
  '!*.pub',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  '.env',
  '.env.*',
  '*.env',
  '.htpasswd',
  '~/.aws/credentials',
  '~/.kube/config',
  '~/.docker/config.json',
  '~/.git-credentials',
  '~/.netrc',
  '~/.pgpass',
  '~/.my.cnf',
  '~/.bash_history',
  '~/.zsh_history',
  '~/.mysql_history',
  '~/.psql_history',
  '~/.gnupg/**',
  '~/.config/gcloud/**',
  '~/.azure/**',
  '/proc/*/environ',
  '**/secrets/**',
  '*secret*',
  '*credential*',
];

const SYSTEM_PREFIXES = [
  '/etc/',
  '/boot/',
  '/usr/bin/',
  '/usr/sbin/',
  '/usr/lib/',
  '/usr/lib64/',
  '/usr/share/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/var/lib/',
  '/var/spool/cron',
  '/sys/',
  '/proc/sys/',
];

const SYSTEM_TOP_DIRS = new Set([
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/sbin',
  '/srv',
  '/sys',
  '/usr',
  '/var',
  '/Users',
  '/System',
  '/Library',
  '/Applications',
]);

const HARMLESS_REDIRECT_TARGETS = /^(\/dev\/null|\/dev\/stdout|\/dev\/stderr|\/dev\/tty|\/dev\/fd\/\d+|-|\d+)$/;
const DEVICE_TARGET = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk|md|dm-|mapper\/|loop)/;
const LOG_TARGET = /^\/var\/log\//;
const SSH_LOCKOUT_PATH = /(authorized_keys2?$|sshd_config|\/etc\/ssh\/|\/etc\/pam\.d\/|\/etc\/hosts\.(allow|deny)$|\/etc\/sudoers)/;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox']);
const CODE_INTERPRETERS = /^(python[0-9.]*|pypy[0-9.]*|perl[0-9.]*|ruby[0-9.]*|node|nodejs|deno|bun|php[0-9.]*|lua[0-9.]*|luajit|Rscript|R|julia|tclsh|wish|osascript|pwsh|powershell|groovy|scala|jshell)$/;
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'aria2c', 'http', 'https', 'xh']);
const SAFE_ENV = /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|COLUMNS|LINES|TERM|NO_COLOR|CLICOLOR|CLICOLOR_FORCE|SYSTEMD_COLORS|FORCE_COLOR)$/;
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', 'elif', '!', '{', '}', 'if', 'while', 'until', 'time']);
const CLOSING_KEYWORDS = new Set(['done', 'fi', 'esac', '}', ')']);

type RuleResult = true | Reason;
type Rule = (args: string[]) => RuleResult;

const modifying = (detail: string): Reason => ({ code: 'modifying-args', detail });

function base(word: string): string {
  const i = word.lastIndexOf('/');
  return i >= 0 ? word.slice(i + 1) : word;
}

/** Non-flag arguments. `valueFlags` lists short options that consume a value. */
function positionals(args: string[], valueFlags = ''): string[] {
  const out: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (endOfOptions) {
      out.push(a);
      continue;
    }
    if (a === '--') {
      endOfOptions = true;
      continue;
    }
    if (a.startsWith('--')) continue;
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k++) {
        if (valueFlags.includes(letters[k])) {
          if (k === letters.length - 1) i++;
          break;
        }
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

/** True when a short option letter appears in any short-option cluster. */
function hasShort(args: string[], letter: string, valueFlags = ''): boolean {
  for (const a of args) {
    if (a === '--') break;
    if (a.startsWith('--') || !a.startsWith('-') || a.length < 2) continue;
    for (const ch of a.slice(1)) {
      if (ch === letter) return true;
      if (valueFlags.includes(ch)) break;
    }
  }
  return false;
}

function hasLong(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.some((n) => a === n || a.startsWith(n + '=')));
}

function subcommand(list: readonly string[], valueFlags = '', allowNone = false): Rule {
  return (args) => {
    const sub = positionals(args, valueFlags)[0];
    if (sub === undefined) return allowNone ? true : modifying('(no subcommand)');
    return list.includes(sub) ? true : modifying(sub);
  };
}

function versionOnly(args: string[]): boolean {
  return args.length === 1 && ['--version', '-V', '-v', 'version', '--help', '-h'].includes(args[0]);
}

const SIMPLE_READ = [
  'cat', 'tac', 'nl', 'head', 'tail', 'rev', 'fold', 'column', 'expand', 'unexpand', 'strings', 'od',
  'hexdump', 'base64', 'base32', 'basenc', 'md5sum', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum',
  'sha512sum', 'b2sum', 'cksum', 'sum', 'wc', 'file', 'stat', 'du', 'df', 'free', 'uptime', 'uname',
  'whoami', 'id', 'groups', 'who', 'w', 'last', 'lastlog', 'lastb', 'users', 'pwd', 'echo', 'printf',
  'true', 'false', 'test', '[', ':', 'sleep', 'which', 'whereis', 'type', 'realpath', 'readlink',
  'basename', 'dirname', 'ls', 'dir', 'vdir', 'lsblk', 'blkid', 'lscpu', 'lsmem', 'lspci', 'lsusb',
  'lsmod', 'modinfo', 'lshw', 'dmidecode', 'nproc', 'getconf', 'arch', 'locale', 'tty', 'grep', 'egrep',
  'fgrep', 'zgrep', 'zegrep', 'zfgrep', 'zcat', 'bzcat', 'xzcat', 'zstdcat', 'lz4cat', 'ag', 'ack', 'diff',
  'cmp', 'comm', 'join', 'paste', 'cut', 'tr', 'jq', 'sensors', 'vmstat', 'iostat', 'mpstat', 'pidstat',
  'sar', 'getent', 'ps', 'pgrep', 'pstree', 'lsof', 'ss', 'netstat', 'dig', 'nslookup', 'host', 'ping',
  'ping6', 'traceroute', 'tracepath', 'findmnt', 'getfacl', 'lsattr', 'namei', 'cd', 'pushd', 'popd',
  'zipinfo', 'numfmt', 'seq', 'cal', 'ncal', 'look', 'fmt', 'pr', 'lsns', 'lslocks', 'lsipc', 'hash',
  'jobs', 'times', 'lsinitramfs', 'whatis', 'apropos', 'dpkg-query', 'systemd-analyze', 'systemd-cgls',
  'pwdx', 'whois',
];

const GIT_READ = new Set([
  'status', 'log', 'show', 'diff', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog',
  'cat-file', 'rev-list', 'name-rev', 'whatchanged', 'show-ref', 'for-each-ref', 'count-objects',
  'version', 'help', 'grep', 'merge-base', 'show-branch', 'cherry', 'range-diff', 'annotate', 'verify-commit',
]);

const DOCKER_READ = new Set(['ps', 'images', 'logs', 'inspect', 'stats', 'top', 'port', 'diff', 'history', 'version', 'info', 'search']);
const DOCKER_GROUP_READ: Record<string, string[]> = {
  container: ['ls', 'list', 'ps', 'inspect', 'logs', 'top', 'port', 'diff', 'stats'],
  image: ['ls', 'list', 'inspect', 'history'],
  network: ['ls', 'list', 'inspect'],
  volume: ['ls', 'list', 'inspect'],
  system: ['df', 'info'],
  compose: ['ps', 'logs', 'config', 'images', 'ls', 'top', 'version', 'port'],
  context: ['ls', 'list', 'show', 'inspect'],
  node: ['ls', 'inspect', 'ps'],
  service: ['ls', 'inspect', 'logs', 'ps'],
  stack: ['ls', 'ps', 'services'],
  buildx: ['ls', 'version', 'inspect'],
  plugin: ['ls', 'inspect'],
  manifest: ['inspect'],
};

const KUBECTL_READ = new Set(['get', 'describe', 'logs', 'top', 'version', 'cluster-info', 'api-resources', 'api-versions', 'explain', 'events']);
const KUBECTL_GROUP_READ: Record<string, string[]> = {
  config: ['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users'],
  auth: ['can-i', 'whoami'],
  rollout: ['status', 'history'],
};

const SYSTEMCTL_READ = [
  'status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed', 'is-system-running', 'list-units',
  'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'list-jobs', 'list-machines',
  'get-default', 'show-environment', 'help',
];

const IP_OBJECTS = new Set([
  'a', 'ad', 'addr', 'address', 'l', 'li', 'lin', 'link', 'r', 'ro', 'rou', 'route', 'n', 'ne', 'nei',
  'neigh', 'neighbor', 'neighbour', 'rule', 'ru', 'maddr', 'maddress', 'm', 'mroute', 'tunnel', 'tun',
  'tuntap', 'netns', 'ntable', 'token', 'netconf', 'vrf', 'stats', 'mptcp', 'nexthop', 'nh',
]);
const IP_READ_ACTIONS = new Set(['show', 'list', 'ls', 'lst', 'sh', 's', 'get', 'l']);

const NVIDIA_SMI_SETTERS = /^(-r|--gpu-reset|-pm|--persistence-mode|-e|--ecc-config|-p|--reset-ecc-errors|-c|--compute-mode|-dm|--driver-model|-fdm|--force-driver-model|-ac|--applications-clocks|-rac|--reset-applications-clocks|-acp|--applications-clocks-permission|-pl|--power-limit|-lgc|--lock-gpu-clocks|-rgc|--reset-gpu-clocks|-lmc|--lock-memory-clocks|-rmc|--reset-memory-clocks|-mig|--multi-instance-gpu|-cc|--cuda-clocks|--auto-boost-default|--auto-boost-permission)(=|$)/;

const RULES: Record<string, Rule> = {
  sed: (args) => {
    if (hasShort(args, 'i', 'efl') || hasLong(args, '--in-place')) return modifying('sed -i');
    if (hasShort(args, 'f', 'el') || hasLong(args, '--file')) return modifying('sed -f');
    const scripts: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-e' || a === '--expression') {
        if (args[i + 1] !== undefined) scripts.push(args[++i]);
      } else if (a.startsWith('--expression=')) scripts.push(a.slice('--expression='.length));
    }
    if (scripts.length === 0) {
      const p = positionals(args, 'efl');
      if (p[0] !== undefined) scripts.push(p[0]);
    }
    for (const s of scripts) {
      if (/(^|[^A-Za-z\\])[wWe](\s|$|;|\})/.test(s)) return modifying('sed w/e command');
    }
    return true;
  },
  awk: awkRule,
  gawk: awkRule,
  mawk: awkRule,
  nawk: awkRule,
  find: (args) => {
    const bad = args.find((a) =>
      ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a),
    );
    return bad ? modifying(`find ${bad}`) : true;
  },
  sort: (args) =>
    hasShort(args, 'o', 'kStT') || hasLong(args, '--output', '--compress-program') ? modifying('sort -o') : true,
  uniq: (args) => (positionals(args, 'fsw').length > 1 ? modifying('uniq OUTPUT') : true),
  tree: (args) => (hasShort(args, 'o', 'LPIH') ? modifying('tree -o') : true),
  xxd: (args) =>
    args.includes('-r') || args.includes('-revert') || positionals(args, 'cglosn').length > 1
      ? modifying('xxd output')
      : true,
  rg: (args) => (hasLong(args, '--pre') ? modifying('rg --pre') : true),
  yq: (args) => (hasShort(args, 'i') || hasLong(args, '--inplace') ? modifying('yq -i') : true),
  tar: (args) => {
    if (!args.length) return modifying('tar');
    const first = args[0];
    let letters = args
      .filter((a) => /^-[A-Za-z]+$/.test(a))
      .map((a) => a.slice(1))
      .join('');
    if (!first.startsWith('-')) letters += first;
    const listing = letters.includes('t') || hasLong(args, '--list');
    const writes =
      /[cxruAIF]/.test(letters) ||
      hasLong(
        args,
        '--create', '--extract', '--get', '--append', '--update', '--delete', '--catenate', '--concatenate',
        '--to-command', '--checkpoint-action', '--use-compress-program', '--rsh-command', '--info-script',
        '--new-volume-script',
      );
    return listing && !writes ? true : modifying('tar (not --list)');
  },
  unzip: (args) => {
    const letters = args.filter((a) => /^-[A-Za-z]+$/.test(a)).map((a) => a.slice(1)).join('');
    return /[lvZtpc]/.test(letters) ? true : modifying('unzip extracts files');
  },
  git: gitRule,
  systemctl: (args) => {
    const sub = positionals(args, 'tpnoHMs')[0];
    if (sub === undefined) return true;
    return SYSTEMCTL_READ.includes(sub) ? true : modifying(`systemctl ${sub}`);
  },
  service: (args) =>
    (args.length === 1 && args[0] === '--status-all') || (args.length === 2 && args[1] === 'status')
      ? true
      : modifying(`service ${args.join(' ')}`),
  journalctl: (args) =>
    hasLong(
      args,
      '--vacuum-size', '--vacuum-time', '--vacuum-files', '--rotate', '--flush', '--sync', '--relinquish-var',
      '--smart-relinquish-var', '--setup-keys', '--update-catalog',
    )
      ? modifying('journalctl maintenance')
      : true,
  dmesg: (args) =>
    hasShort(args, 'c') || hasShort(args, 'C') || hasShort(args, 'D') || hasShort(args, 'E') || hasShort(args, 'n') ||
    hasLong(args, '--clear', '--read-clear', '--console-off', '--console-on', '--console-level')
      ? modifying('dmesg clear/console')
      : true,
  docker: dockerRule,
  podman: dockerRule,
  nerdctl: dockerRule,
  'docker-compose': (args) => {
    const sub = positionals(args, 'fp')[0];
    return sub !== undefined && DOCKER_GROUP_READ.compose.includes(sub) ? true : modifying(`docker-compose ${sub ?? ''}`);
  },
  kubectl: kubectlRule,
  oc: kubectlRule,
  helm: subcommand(['list', 'ls', 'status', 'get', 'history', 'show', 'search', 'version', 'env', 'template', 'lint'], 'n'),
  ip: (args) => {
    if (args.some((a) => a === '-b' || a === '-batch' || a === '--batch' || a.startsWith('-force'))) return modifying('ip -batch');
    const pos = positionals(args, 'nf');
    const [obj, action] = pos;
    if (obj === undefined) return true;
    if (!IP_OBJECTS.has(obj)) return modifying(`ip ${obj}`);
    if (action === undefined || IP_READ_ACTIONS.has(action)) return true;
    return modifying(`ip ${obj} ${action}`);
  },
  ifconfig: (args) =>
    args.length === 0 || (args.length === 1 && (args[0] === '-a' || /^[\w.:-]+$/.test(args[0])))
      ? true
      : modifying('ifconfig change'),
  hostname: (args) =>
    args.every((a) =>
      ['-f', '-s', '-d', '-i', '-I', '-A', '-a', '-y', '--fqdn', '--long', '--short', '--domain', '--ip-address',
        '--all-ip-addresses', '--all-fqdns', '--alias', '--yp', '--nis'].includes(a),
    )
      ? true
      : modifying('hostname NEWNAME'),
  date: (args) => {
    if (hasShort(args, 's', 'dfrI') || hasLong(args, '--set')) return modifying('date --set');
    return positionals(args, 'dfr').every((p) => p.startsWith('+')) ? true : modifying('date TIME');
  },
  timedatectl: subcommand(['status', 'show', 'list-timezones', 'timesync-status', 'show-timesync'], '', true),
  hostnamectl: subcommand(['status'], '', true),
  localectl: subcommand(['status', 'list-locales', 'list-keymaps', 'list-x11-keymap-models'], '', true),
  loginctl: subcommand(['list-sessions', 'list-users', 'list-seats', 'show-session', 'show-user', 'session-status', 'user-status', 'seat-status'], '', true),
  crontab: (args) =>
    args.includes('-l') && !args.some((a) => ['-r', '-e', '-i'].includes(a)) ? true : modifying('crontab'),
  apt: subcommand(['list', 'show', 'search', 'policy', 'depends', 'rdepends', 'changelog', 'showsrc']),
  'apt-cache': subcommand(['show', 'search', 'policy', 'depends', 'rdepends', 'showpkg', 'stats', 'madison', 'pkgnames']),
  dpkg: (args) =>
    args.some((a) => /^(-l|-L|-s|-S|-p|--list|--listfiles|--status|--search|--print-avail|--get-selections|--print-architecture|--version)$/.test(a)) &&
    !args.some((a) => /^(-i|-r|-P|-a|--install|--remove|--purge|--configure|--unpack|--set-selections)$/.test(a))
      ? true
      : modifying('dpkg change'),
  rpm: (args) =>
    args.some((a) => /^-q/.test(a) || a === '--query' || a === '--version') &&
    !args.some((a) => /^-(i|U|F|e)/.test(a) || /^--(install|upgrade|freshen|erase|import|rebuilddb|setperms|setugids)/.test(a))
      ? true
      : modifying('rpm change'),
  yum: subcommand(['list', 'info', 'search', 'check-update', 'repolist', 'provides', 'whatprovides', 'deplist', 'repoquery', 'history']),
  dnf: subcommand(['list', 'info', 'search', 'check-update', 'repolist', 'provides', 'repoquery', 'history']),
  snap: subcommand(['list', 'info', 'find', 'services', 'version', 'changes', 'connections']),
  flatpak: subcommand(['list', 'info', 'search', 'remotes', 'history']),
  pip: subcommand(['list', 'show', 'freeze', 'check', 'index']),
  pip3: subcommand(['list', 'show', 'freeze', 'check', 'index']),
  npm: subcommand(['ls', 'list', 'view', 'info', 'outdated', 'audit', 'explain', 'why', 'doctor', 'ping']),
  brew: subcommand(['list', 'ls', 'info', 'outdated', 'search', 'deps', 'leaves', 'config', 'doctor', 'uses', 'desc']),
  'nvidia-smi': (args) => {
    const bad = args.find((a) => NVIDIA_SMI_SETTERS.test(a));
    return bad ? modifying(`nvidia-smi ${bad}`) : true;
  },
  sysctl: (args) =>
    hasShort(args, 'w') || hasShort(args, 'p') || hasLong(args, '--write', '--load', '--system') || args.some((a) => a.includes('='))
      ? modifying('sysctl -w')
      : true,
  iptables: iptablesRule,
  ip6tables: iptablesRule,
  nft: (args) => (positionals(args, 'f')[0] === 'list' ? true : modifying('nft change')),
  ufw: (args) => {
    const sub = positionals(args)[0];
    return sub === 'status' || sub === 'version' || args[0] === '--version' ? true : modifying(`ufw ${sub ?? ''}`);
  },
  'firewall-cmd': (args) =>
    args.length > 0 && args.every((a) => /^--(list-|get-|query-|info-|state$|zone=|permanent$|version$)/.test(a))
      ? true
      : modifying('firewall-cmd change'),
  top: (args) => (hasShort(args, 'b', 'dnpuUoOw') ? true : modifying('top (interactive)')),
  fuser: (args) => (hasShort(args, 'k') ? modifying('fuser -k') : true),
  arp: (args) => (hasShort(args, 'd') || hasShort(args, 's') || hasShort(args, 'f') ? modifying('arp change') : true),
  route: (args) => (args.every((a) => a.startsWith('-')) ? true : modifying('route change')),
  mount: (args) =>
    args.every((a) => ['-l', '--show-labels', '-v', '--verbose'].includes(a)) ? true : modifying('mount'),
  swapon: (args) =>
    args.length > 0 && args.every((a) => ['--show', '-s', '--summary', '--bytes', '--noheadings', '--raw'].includes(a) || a.startsWith('--show='))
      ? true
      : modifying('swapon'),
  history: (args) =>
    args.some((a) => ['-c', '-d', '-w', '-r', '-a', '-n', '-s'].includes(a)) ? { code: 'history-tamper' } : true,
  command: (args) => (args[0] === '-v' || args[0] === '-V' ? true : modifying('command')),
  ulimit: (args) => (args.every((a) => /^-[a-zA-Z]+$/.test(a)) ? true : modifying('ulimit set')),
  umask: (args) => (args.length === 0 || (args.length === 1 && args[0] === '-S') ? true : modifying('umask set')),
  openssl: (args) => {
    const sub = args[0];
    if (['version', 'ciphers', 'list', 's_client', 'help'].includes(sub ?? '')) return true;
    if (sub === 'x509' && args.includes('-noout') && !args.some((a) => ['-out', '-signkey', '-CA', '-req'].includes(a))) return true;
    return modifying(`openssl ${sub ?? ''}`);
  },
};

function awkRule(args: string[]): RuleResult {
  if (args.some((a) => a === '-f' || a.startsWith('--file') || a === '-i' || a.startsWith('--include') || a === '-l' || a.startsWith('--load') || a === '-E' || a.startsWith('--exec'))) {
    return modifying('awk -f/-i/-l');
  }
  const program = args.find((a, idx) => !a.startsWith('-') && !(idx > 0 && ['-F', '-v', '--field-separator', '--assign'].includes(args[idx - 1])));
  if (program !== undefined && /system|\||>|getline/.test(program)) return modifying('awk system/redirect');
  return true;
}

function gitRule(args: string[]): RuleResult {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') {
      i += 2;
      continue;
    }
    if (a === '--no-pager' || a === '-P' || a === '--no-optional-locks' || a === '--literal-pathspecs') {
      i++;
      continue;
    }
    return modifying(`git ${a}`);
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return true;
  if (hasLong(rest, '--output', '--ext-diff', '--open-files-in-pager') || rest.includes('-O')) return modifying(`git ${sub} --output`);
  if (GIT_READ.has(sub)) return true;
  switch (sub) {
    case 'branch': {
      const flagsOk = rest
        .filter((a) => a.startsWith('-'))
        .every((a) =>
          /^(-a|-r|-v|-vv|--verbose|--all|--remotes|--list|-l|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--sort=.*|--format=.*|--color.*|--no-color|--column.*|--no-column|-i|--ignore-case)$/.test(a),
        );
      const filtering = rest.some((a) => ['--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'].includes(a));
      const names = rest.some((a) => !a.startsWith('-'));
      return flagsOk && (!names || filtering) ? true : modifying('git branch change');
    }
    case 'tag': {
      const flagsOk = rest
        .filter((a) => a.startsWith('-'))
        .every((a) => /^(-l|--list|-n\d*|--sort=.*|--contains|--no-contains|--points-at|--merged|--no-merged|--format=.*|--color.*|-i|--ignore-case|--column.*)$/.test(a));
      const listing = rest.length === 0 || rest.includes('-l') || rest.includes('--list');
      return flagsOk && listing ? true : modifying('git tag change');
    }
    case 'remote':
      return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url' ? true : modifying('git remote change');
    case 'config':
      return rest.some((a) => ['--get', '--get-all', '--list', '-l', '--get-regexp', '--get-urlmatch'].includes(a)) &&
        !rest.some((a) => ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit'].includes(a))
        ? true
        : modifying('git config change');
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show' ? true : modifying('git stash');
    case 'worktree':
      return rest[0] === 'list' ? true : modifying('git worktree');
    case 'submodule':
      return rest[0] === 'status' || rest.length === 0 ? true : modifying('git submodule');
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show' ? true : modifying('git reflog');
    default:
      return modifying(`git ${sub}`);
  }
}

function dockerRule(args: string[]): RuleResult {
  const pos = positionals(args, 'Hcfpl');
  const [sub, sub2] = pos;
  if (sub === undefined) return true;
  if (DOCKER_READ.has(sub)) return true;
  if (DOCKER_GROUP_READ[sub]?.includes(sub2 ?? '')) return true;
  return modifying(`${sub}${sub2 ? ' ' + sub2 : ''}`);
}

function kubectlRule(args: string[]): RuleResult {
  const pos = positionals(args, 'nlocfs');
  const [sub, sub2] = pos;
  if (sub === undefined) return true;
  if (KUBECTL_READ.has(sub)) return true;
  if (KUBECTL_GROUP_READ[sub]?.includes(sub2 ?? '')) return true;
  return modifying(`${sub}${sub2 ? ' ' + sub2 : ''}`);
}

function iptablesRule(args: string[]): RuleResult {
  const lists = args.some((a) => a === '--list' || a === '--list-rules' || /^-[A-Za-z]*[LS]/.test(a));
  const changes = args.some(
    (a) =>
      /^-[A-Za-z]*[ADIRFZNXPE]/.test(a) ||
      ['--append', '--delete', '--insert', '--replace', '--flush', '--zero', '--new-chain', '--delete-chain', '--policy', '--rename-chain'].includes(a),
  );
  return lists && !changes ? true : modifying('iptables change');
}

// ---------------------------------------------------------------------------
// Glob helpers for sensitive paths and allow/deny patterns

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(c);
    }
  }
  return out;
}

interface CompiledPathPatterns {
  include: RegExp[];
  exclude: RegExp[];
}

const pathPatternCache = new Map<string, CompiledPathPatterns>();

function compilePathPatterns(patterns: string[]): CompiledPathPatterns {
  const key = patterns.join('\n');
  const cached = pathPatternCache.get(key);
  if (cached) return cached;
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const raw of patterns) {
    let p = raw.trim();
    if (!p) continue;
    const negate = p.startsWith('!');
    if (negate) p = p.slice(1);
    let rx: string;
    if (p.startsWith('~/')) {
      const rest = globToRegex(p.slice(2));
      rx = `(^|/)${rest}$`;
    } else if (p.startsWith('/')) {
      rx = `^${globToRegex(p)}$`;
    } else if (p.includes('/')) {
      rx = `(^|/)${globToRegex(p)}$`;
    } else {
      rx = `(^|/)${globToRegex(p)}$`;
    }
    try {
      (negate ? exclude : include).push(new RegExp(rx, 'i'));
    } catch {
      /* ignore invalid */
    }
  }
  const compiled = { include, exclude };
  if (pathPatternCache.size > 32) pathPatternCache.clear();
  pathPatternCache.set(key, compiled);
  return compiled;
}

/** Strips quoting leftovers and `--opt=` prefixes so a word can be tested as a path. */
function pathCandidate(word: string): string {
  let w = word;
  const eq = w.indexOf('=');
  if (w.startsWith('-') && eq > 0) w = w.slice(eq + 1);
  else if (/^[A-Za-z_]*(if|of)=/.test(w)) w = w.slice(eq + 1);
  return w.replace(/^["']|["']$/g, '');
}

export function isSensitivePath(path: string, patterns: string[] = DEFAULT_SENSITIVE_PATHS): boolean {
  const candidate = pathCandidate(path).replace(/^(\$HOME|\$\{HOME\})/, '~');
  if (!candidate || candidate.length > 4096) return false;
  const { include, exclude } = compilePathPatterns(patterns);
  if (exclude.some((rx) => rx.test(candidate))) return false;
  return include.some((rx) => rx.test(candidate));
}

export function isSystemPath(path: string): boolean {
  const p = pathCandidate(path);
  if (SYSTEM_TOP_DIRS.has(p.replace(/\/+$/, ''))) return true;
  return SYSTEM_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export function matchCommandPattern(command: string, pattern: string): boolean {
  const cmd = normalizeCommand(command);
  const p = pattern.trim();
  if (!p) return false;
  const rx = /^\/(.+)\/([imsu]*)$/.exec(p);
  if (rx) {
    try {
      return new RegExp(rx[1], rx[2]).test(cmd);
    } catch {
      return false;
    }
  }
  const np = normalizeCommand(p);
  if (np.includes('*')) {
    const source = '^' + np.split('*').map(escapeRegex).join('.*') + '$';
    return new RegExp(source).test(cmd);
  }
  return cmd === np;
}

// ---------------------------------------------------------------------------
// Classification

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

function extraReadOnlyMatch(prog: string, args: string[], extra: string[] | undefined): boolean {
  if (!extra?.length) return false;
  const line = [prog, ...args].join(' ');
  return extra.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    if (!e.includes(' ')) return e === prog;
    return line === e || line.startsWith(e + ' ');
  });
}

function checkPathWord(ctx: Ctx, word: string) {
  if (!word || word.startsWith('-') && !word.includes('=')) return;
  if (isSensitivePath(word, ctx.sensitivePatterns)) push(ctx, 'sensitive-path', pathCandidate(word));
}

function checkWriteTarget(ctx: Ctx, target: string) {
  const t = pathCandidate(target);
  if (DEVICE_TARGET.test(t)) push(ctx, 'device-overwrite', t);
  else if (LOG_TARGET.test(t)) push(ctx, 'history-tamper', t);
  if (SSH_LOCKOUT_PATH.test(t)) push(ctx, 'ssh-lockout', t);
  else if (isSystemPath(t)) push(ctx, 'system-file-write', t);
}

function checkRedirects(ctx: Ctx, redirects: Redirect[]) {
  for (const r of redirects) {
    const writes = ['>', '>>', '>|', '&>', '&>>', '<>'].includes(r.op) || (r.op === '>&' && !/^(\d+|-)$/.test(r.target));
    if (writes) {
      if (HARMLESS_REDIRECT_TARGETS.test(r.target)) continue;
      push(ctx, 'redirect-write', r.target);
      checkWriteTarget(ctx, r.target);
    } else if (r.op === '<' || r.op === '<&') {
      checkPathWord(ctx, r.target);
    }
  }
}

function rmDanger(ctx: Ctx, args: string[]) {
  const flags = args.filter((a) => a.startsWith('-') && a !== '--');
  const recursive = flags.some((f) => f === '--recursive' || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)));
  const force = flags.some((f) => f === '--force' || (/^-[a-zA-Z]+$/.test(f) && f.includes('f')));
  const targets = positionals(args);
  const catastrophic =
    flags.includes('--no-preserve-root') ||
    targets.some((t) => {
      const n = t.replace(/\/+$/, '') || '/';
      return (
        n === '/' || n === '/*' || n === '~' || n === '~/*' || n === '$HOME' || n === '${HOME}' || n === '$HOME/*' ||
        n === '/.*' || SYSTEM_TOP_DIRS.has(n) || SYSTEM_TOP_DIRS.has(n.replace(/\/\*$/, ''))
      );
    });
  if (catastrophic && recursive) push(ctx, 'root-delete', targets.join(' '));
  else if (recursive || force) push(ctx, 'recursive-delete', targets.join(' '));
  else push(ctx, 'delete', targets.join(' '));
  for (const t of targets) if (isSystemPath(t)) push(ctx, 'system-file-write', t);
}

const SSH_SERVICES = /^(ssh|sshd|ssh\.service|sshd\.service|ssh\.socket|networking|network|NetworkManager|systemd-networkd|systemd-resolved|wpa_supplicant|tailscaled|wg-quick@.*)$/;

function segmentDanger(ctx: Ctx, prog: string, args: string[]) {
  const pos = positionals(args);
  const lower = args.map((a) => a.toLowerCase());
  switch (prog) {
    case 'rm':
      rmDanger(ctx, args);
      break;
    case 'rmdir':
    case 'unlink':
      push(ctx, 'delete', pos.join(' '));
      for (const t of pos) if (isSystemPath(t)) push(ctx, 'system-file-write', t);
      break;
    case 'shred':
    case 'wipefs':
    case 'mke2fs':
    case 'mkswap':
    case 'fdisk':
    case 'sfdisk':
    case 'cfdisk':
    case 'gdisk':
    case 'sgdisk':
    case 'parted':
    case 'blkdiscard':
    case 'diskutil':
      push(ctx, 'disk-destroy', prog);
      break;
    case 'dd': {
      const of = args.find((a) => a.startsWith('of='));
      if (of) {
        const target = of.slice(3);
        if (DEVICE_TARGET.test(target)) push(ctx, 'device-overwrite', target);
        else checkWriteTarget(ctx, target);
        push(ctx, 'redirect-write', target);
      }
      break;
    }
    case 'shutdown':
    case 'reboot':
    case 'halt':
    case 'poweroff':
    case 'telinit':
    case 'kexec':
      push(ctx, 'power', prog);
      break;
    case 'init':
      if (['0', '6', '1', 's', 'S'].includes(pos[0] ?? '')) push(ctx, 'power', `init ${pos[0]}`);
      break;
    case 'systemctl': {
      const sub = positionals(args, 'tpnoHMs')[0] ?? '';
      if (['poweroff', 'reboot', 'halt', 'kexec', 'suspend', 'hibernate', 'hybrid-sleep', 'rescue', 'emergency', 'isolate', 'soft-reboot'].includes(sub)) {
        push(ctx, 'power', `systemctl ${sub}`);
      }
      if (['stop', 'disable', 'mask', 'kill', 'restart', 'try-restart', 'reload-or-restart'].includes(sub)) {
        const units = positionals(args, 'tpnoHMs').slice(1);
        if (units.some((u) => SSH_SERVICES.test(u))) push(ctx, 'ssh-lockout', `systemctl ${sub} ${units.join(' ')}`);
      }
      break;
    }
    case 'service':
      if (SSH_SERVICES.test(pos[0] ?? '') && ['stop', 'restart'].includes(pos[1] ?? '')) push(ctx, 'ssh-lockout', `service ${pos.join(' ')}`);
      break;
    case 'iptables':
    case 'ip6tables':
    case 'nft':
    case 'ufw':
    case 'firewall-cmd':
    case 'pfctl':
    case 'iptables-restore':
    case 'ip6tables-restore':
    case 'setenforce':
      if (RULES[prog]?.(args) !== true) push(ctx, 'firewall', prog);
      break;
    case 'ip':
      if (RULES.ip(args) !== true) push(ctx, 'firewall', `ip ${pos.slice(0, 2).join(' ')}`);
      break;
    case 'ifconfig':
    case 'ifdown':
    case 'ifup':
    case 'nmcli':
      if (prog !== 'ifconfig' || RULES.ifconfig(args) !== true) push(ctx, 'firewall', prog);
      break;
    case 'userdel':
    case 'deluser':
    case 'usermod':
    case 'passwd':
    case 'chpasswd':
    case 'chage':
    case 'visudo':
    case 'groupdel':
    case 'delgroup':
    case 'gpasswd':
      push(ctx, 'user-account', prog);
      break;
    case 'chmod':
    case 'chown':
    case 'chgrp':
    case 'setfacl': {
      const recursive = hasShort(args, 'R') || hasLong(args, '--recursive');
      const targets = pos.slice(prog === 'setfacl' ? 0 : 1);
      if (recursive) push(ctx, 'permissions-recursive', `${prog} -R ${targets.join(' ')}`);
      for (const t of targets) {
        if (SSH_LOCKOUT_PATH.test(t) || /(^|\/)\.ssh\/?$/.test(t)) push(ctx, 'ssh-lockout', t);
        else if (isSystemPath(t)) push(ctx, 'system-file-write', t);
      }
      if (prog === 'chmod' && /^[0-7]*7[0-7]7$/.test(pos[0] ?? '') && targets.some((t) => isSystemPath(t))) {
        push(ctx, 'permissions-recursive', `chmod ${pos[0]}`);
      }
      break;
    }
    case 'kill':
      if (pos.includes('-1') || pos.includes('1') || args.includes('-1')) push(ctx, 'kill-processes', 'kill -1 / init');
      break;
    case 'killall':
    case 'pkill':
    case 'killall5':
      push(ctx, 'kill-processes', prog);
      break;
    case 'apt':
    case 'apt-get':
    case 'aptitude':
    case 'yum':
    case 'dnf':
    case 'zypper':
    case 'pacman':
    case 'apk':
    case 'snap':
    case 'brew':
    case 'pip':
    case 'pip3':
    case 'npm':
    case 'gem': {
      const sub = pos[0] ?? '';
      if (['remove', 'purge', 'autoremove', 'erase', 'uninstall', 'del', 'rm', 'dist-upgrade', 'full-upgrade', 'autoclean'].includes(sub) ||
        (prog === 'pacman' && args.some((a) => /^-R/.test(a)))) {
        push(ctx, 'package-remove', `${prog} ${sub}`);
      }
      break;
    }
    case 'dpkg':
      if (args.some((a) => /^(-r|-P|--remove|--purge)$/.test(a))) push(ctx, 'package-remove', 'dpkg remove');
      break;
    case 'rpm':
      if (args.some((a) => /^-e|^--erase/.test(a))) push(ctx, 'package-remove', 'rpm -e');
      break;
    case 'docker':
    case 'podman':
    case 'nerdctl': {
      const p = positionals(args, 'Hcfpl');
      const [s1, s2] = p;
      if (
        ['rm', 'rmi', 'kill'].includes(s1 ?? '') ||
        (['system', 'image', 'container', 'volume', 'network', 'builder', 'buildx'].includes(s1 ?? '') && ['prune', 'rm', 'remove'].includes(s2 ?? '')) ||
        (s1 === 'compose' && ['down', 'rm', 'kill'].includes(s2 ?? '')) ||
        (s1 === 'swarm' && s2 === 'leave') ||
        (s1 === 'stack' && ['rm', 'remove'].includes(s2 ?? '')) ||
        (s1 === 'run' && (args.includes('--privileged') || args.some((a) => /^(-v|--volume)=?\/:/.test(a)) || args.some((a, i) => (args[i - 1] === '-v' || args[i - 1] === '--volume') && a.startsWith('/:'))))
      ) {
        push(ctx, 'container-destroy', `${prog} ${p.slice(0, 2).join(' ')}`);
      }
      break;
    }
    case 'docker-compose':
      if (['down', 'rm', 'kill'].includes(pos[0] ?? '')) push(ctx, 'container-destroy', `docker-compose ${pos[0]}`);
      break;
    case 'kubectl':
    case 'oc': {
      const p = positionals(args, 'nlocfs');
      if (['delete', 'drain', 'cordon', 'replace', 'taint'].includes(p[0] ?? '') || (p[0] === 'scale' && args.some((a) => /--replicas=0\b/.test(a))) || (p[0] === 'rollout' && p[1] === 'undo')) {
        push(ctx, 'container-destroy', `${prog} ${p.slice(0, 2).join(' ')}`);
      }
      break;
    }
    case 'helm':
      if (['uninstall', 'delete', 'rollback', 'del'].includes(pos[0] ?? '')) push(ctx, 'container-destroy', `helm ${pos[0]}`);
      break;
    case 'git': {
      const sub = args.find((a) => !a.startsWith('-')) ?? '';
      const rest = args.slice(args.indexOf(sub) + 1);
      if (
        (sub === 'push' && (rest.some((a) => /^(-f|--force|--force-with-lease|--mirror|--delete|-d|--prune)(=|$)/.test(a)) || rest.some((a) => a.startsWith(':') || a.startsWith('+')))) ||
        (sub === 'reset' && rest.includes('--hard')) ||
        (sub === 'clean' && rest.some((a) => /^-[a-zA-Z]*f/.test(a) || a === '--force')) ||
        (sub === 'branch' && rest.some((a) => a === '-D' || (a === '-d' && rest.includes('--force')))) ||
        sub === 'filter-branch' || sub === 'filter-repo' ||
        (sub === 'reflog' && rest[0] === 'expire') ||
        (sub === 'checkout' && rest.includes('--') && rest.includes('.')) ||
        (sub === 'restore' && rest.includes('.') && !rest.includes('--staged'))
      ) {
        push(ctx, 'git-destructive', `git ${sub} ${rest.join(' ')}`.trim());
      }
      break;
    }
    case 'terraform':
    case 'tofu':
    case 'pulumi':
    case 'cdk':
      if (pos[0] === 'destroy' || (pos[0] === 'apply' && args.some((a) => /^-?-auto-approve/.test(a))) || ((pos[0] === 'up' || pos[0] === 'destroy') && args.some((a) => a === '--yes' || a === '-y'))) {
        push(ctx, 'infra-destroy', `${prog} ${pos[0]}`);
      }
      break;
    case 'crontab':
      if (args.includes('-r')) push(ctx, 'crontab-remove');
      break;
    case 'unset':
      if (args.some((a) => a.startsWith('HIST'))) push(ctx, 'history-tamper', 'unset HISTFILE');
      break;
    case 'truncate':
      for (const t of positionals(args, 'sr')) checkWriteTarget(ctx, t);
      break;
    case 'cp':
    case 'install':
    case 'rsync':
    case 'ln': {
      const p = positionals(args, prog === 'install' ? 'mgot' : 'tSb');
      const dest = p[p.length - 1];
      if (dest !== undefined && p.length > 1) checkWriteTarget(ctx, dest);
      if (prog === 'rsync' && hasLong(args, '--delete', '--delete-before', '--delete-after', '--delete-during', '--remove-source-files')) {
        push(ctx, 'recursive-delete', 'rsync --delete');
      }
      break;
    }
    case 'mv':
      for (const t of positionals(args, 'tSb')) if (isSystemPath(t)) push(ctx, 'system-file-write', t);
      break;
    case 'tee':
      for (const t of positionals(args)) checkWriteTarget(ctx, t);
      break;
    case 'sed':
    case 'perl':
      if (hasShort(args, 'i', 'efl') || hasLong(args, '--in-place')) {
        for (const t of positionals(args, 'efl').slice(1)) checkWriteTarget(ctx, t);
      }
      break;
    case 'touch':
    case 'mkdir':
    case 'chattr':
      for (const t of pos) if (isSystemPath(t)) push(ctx, 'system-file-write', t);
      break;
    case 'mysql':
    case 'mariadb':
    case 'psql':
    case 'sqlite3':
    case 'mongo':
    case 'mongosh':
    case 'redis-cli':
    case 'clickhouse-client':
    case 'cqlsh':
      if (lower.some((a) => /\b(flushall|flushdb)\b/.test(a))) push(ctx, 'database-destroy', `${prog} FLUSH`);
      break;
    default:
      if (/^mkfs(\.|$)/.test(prog)) push(ctx, 'disk-destroy', prog);
  }
}

function analyzeSegment(ctx: Ctx, seg: Segment, depth: number): { prog?: string; readsStdinAsCode: boolean } {
  let words = [...seg.words];
  checkRedirects(ctx, seg.redirects);

  while (words.length && LEADING_KEYWORDS.has(words[0])) words.shift();
  if (!words.length) return { readsStdinAsCode: false };
  if (words.length === 1 && CLOSING_KEYWORDS.has(words[0])) return { readsStdinAsCode: false };
  if (['for', 'case', 'select', 'in'].includes(words[0])) {
    // Loop / case headers only expand words; the body is analysed separately.
    for (const w of words.slice(1)) checkPathWord(ctx, w);
    return { readsStdinAsCode: false };
  }
  if (words[0] === 'function' || /^[A-Za-z_][\w.-]*\(\)$/.test(words[0])) {
    push(ctx, 'interpreter', 'function definition');
    return { readsStdinAsCode: false };
  }

  // Assignments and transparent wrappers.
  for (;;) {
    if (!words.length) break;
    const w = words[0];
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(w);
    if (assign) {
      if (!SAFE_ENV.test(assign[1])) push(ctx, 'env-assignment', assign[1]);
      words.shift();
      continue;
    }
    const b = base(w);
    if (b === 'sudo' || b === 'doas') {
      push(ctx, 'sudo');
      words.shift();
      while (words.length && words[0].startsWith('-')) {
        const o = words.shift()!;
        if (o === '--') break;
        if (o.startsWith('--')) {
          if (['--shell', '--login', '--edit'].includes(o)) push(ctx, 'interpreter', `sudo ${o}`);
          if (['--user', '--group', '--host', '--prompt', '--close-from', '--other-user', '--role', '--type', '--command-timeout', '--chdir'].includes(o)) words.shift();
          continue;
        }
        const letters = o.slice(1);
        for (let k = 0; k < letters.length; k++) {
          const ch = letters[k];
          if ('sie'.includes(ch)) push(ctx, 'interpreter', `sudo -${ch}`);
          if ('ughpCUrtTD'.includes(ch)) {
            if (k === letters.length - 1) words.shift();
            break;
          }
        }
      }
      continue;
    }
    if (b === 'nohup' || b === 'time' || b === 'builtin' || b === 'exec') {
      words.shift();
      continue;
    }
    if (b === 'command') {
      if (words[1] === '-v' || words[1] === '-V') break;
      words.shift();
      if (words[0] === '-p') words.shift();
      continue;
    }
    if (b === 'nice') {
      words.shift();
      if (words[0] === '-n') words.splice(0, 2);
      else if (words[0] !== undefined && (/^-n?-?\d+$/.test(words[0]) || words[0].startsWith('--adjustment'))) words.shift();
      continue;
    }
    if (b === 'ionice' || b === 'stdbuf' || b === 'timeout' || b === 'chrt' || b === 'taskset') {
      words.shift();
      while (words.length && words[0].startsWith('-')) {
        const o = words.shift()!;
        if (/^-[cnpioeskt]$/.test(o) || ['--signal', '--kill-after'].includes(o)) words.shift();
      }
      if (b === 'timeout' || b === 'chrt' || b === 'taskset') words.shift();
      continue;
    }
    if (b === 'env') {
      const rest = words.slice(1);
      if (rest.every((x) => x.startsWith('-') && !['-u', '-C', '-S', '--unset', '--chdir'].includes(x))) break;
      words.shift();
      while (words.length && words[0].startsWith('-')) {
        const o = words.shift()!;
        if (['-u', '-C', '--unset', '--chdir'].includes(o)) words.shift();
        if (o === '-S' || o.startsWith('--split-string')) push(ctx, 'interpreter', 'env -S');
      }
      continue;
    }
    break;
  }
  if (!words.length) return { readsStdinAsCode: false };

  const progWord = words[0];
  if (/[$`]|\$\(…\)/.test(progWord)) {
    push(ctx, 'variable-command', progWord);
    return { readsStdinAsCode: false };
  }
  const prog = base(progWord);
  const args = words.slice(1);
  ctx.programs.push(prog);

  let readsStdinAsCode = false;

  if (SHELLS.has(prog)) {
    const cIdx = args.findIndex((a) => a === '-c' || /^-[a-zA-Z]*c$/.test(a));
    if (cIdx >= 0 && args[cIdx + 1] !== undefined) {
      push(ctx, 'interpreter', `${prog} -c`);
      if (depth < 4) analyze(ctx, args[cIdx + 1], depth + 1);
    } else if (!versionOnly(args)) {
      push(ctx, 'interpreter', prog);
      readsStdinAsCode = positionals(args, 'o').length === 0 || args.includes('-s');
    }
  } else if (prog === 'eval') {
    push(ctx, 'interpreter', 'eval');
    if (depth < 4) analyze(ctx, args.join(' '), depth + 1);
  } else if (prog === 'source' || prog === '.') {
    push(ctx, 'interpreter', prog);
  } else if (prog === 'su') {
    push(ctx, 'interpreter', 'su');
    const cIdx = args.findIndex((a) => a === '-c' || a === '--command');
    if (cIdx >= 0 && args[cIdx + 1] !== undefined && depth < 4) analyze(ctx, args[cIdx + 1], depth + 1);
  } else if (CODE_INTERPRETERS.test(prog)) {
    if (!versionOnly(args)) {
      push(ctx, 'interpreter', prog);
      readsStdinAsCode = positionals(args, 'cemW').length === 0 || args.includes('-');
      const inline = args.findIndex((a) => ['-c', '-e', '-E', '-r', '--eval', '-p', '--print'].includes(a));
      if (inline >= 0) readsStdinAsCode = false;
    }
  } else if (['ssh', 'scp', 'sftp', 'mosh', 'telnet', 'nc', 'ncat', 'netcat', 'socat', 'rsh', 'rlogin'].includes(prog)) {
    push(ctx, 'network-tool', prog);
  } else if (DOWNLOADERS.has(prog)) {
    push(ctx, 'network-tool', prog);
    if (args.some((a) => /^(-o|-O|--output|--remote-name|--output-document)/.test(a))) push(ctx, 'redirect-write', `${prog} -o`);
  } else if (prog === 'xargs' || prog === 'watch' || prog === 'parallel') {
    push(ctx, 'unknown-program', prog);
    let rest = args;
    while (rest.length && rest[0].startsWith('-')) {
      const o = rest[0];
      rest = rest.slice(1);
      if (/^-[IiLlnPsdEaN]$/.test(o) || o === '--max-args' || o === '--interval') rest = rest.slice(1);
    }
    if (rest.length && depth < 4) analyzeSegment(ctx, { words: rest, redirects: [] }, depth + 1);
  } else if (['env', 'printenv'].includes(prog) || (['set', 'declare', 'typeset', 'export'].includes(prog) && (args.length === 0 || args.every((a) => a === '-p' || a === '-x')))) {
    push(ctx, 'sensitive-command', prog);
  } else if (['export', 'set', 'declare', 'typeset', 'alias', 'unalias', 'readonly', 'local', 'shopt', 'trap', 'unset'].includes(prog)) {
    push(ctx, 'env-assignment', prog);
  } else if (prog === 'find' && args.some((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a))) {
    push(ctx, 'modifying-args', 'find -exec');
    for (let i = 0; i < args.length; i++) {
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(args[i])) {
        const sub: string[] = [];
        for (let j = i + 1; j < args.length && args[j] !== ';' && args[j] !== '+'; j++) sub.push(args[j]);
        if (sub.length && depth < 4) analyzeSegment(ctx, { words: sub, redirects: [] }, depth + 1);
      }
    }
    if (args.includes('-delete')) push(ctx, 'recursive-delete', 'find -delete');
  } else if (extraReadOnlyMatch(prog, args, ctx.opts.extraReadOnly)) {
    // user-declared read-only
  } else if (SIMPLE_READ.includes(prog)) {
    // read-only
  } else if (RULES[prog]) {
    const res = RULES[prog](args);
    if (res !== true) push(ctx, res.code, res.detail);
  } else {
    push(ctx, 'unknown-program', prog);
  }

  if (prog === 'find' && args.includes('-delete')) push(ctx, 'recursive-delete', 'find -delete');
  segmentDanger(ctx, prog, args);
  for (const a of args) checkPathWord(ctx, a);
  return { prog, readsStdinAsCode };
}

function analyze(ctx: Ctx, command: string, depth: number) {
  const parsed = parseShell(command);
  const f = parsed.flags;
  if (f.parseError) push(ctx, 'parse-error');
  if (f.substitution) push(ctx, 'substitution');
  if (f.processSubstitution) push(ctx, 'process-substitution');
  if (f.background) push(ctx, 'background');
  for (const inner of parsed.inner) {
    if (depth < 4) analyze(ctx, inner, depth + 1);
    else push(ctx, 'parse-error', 'nesting too deep');
  }
  let pipelineHasDownloader = false;
  parsed.segments.forEach((seg, idx) => {
    const prevOp = idx > 0 ? parsed.operators[idx - 1] : '';
    const piped = prevOp === '|' || prevOp === '|&';
    if (!piped) pipelineHasDownloader = false;
    const info = analyzeSegment(ctx, seg, depth);
    if (piped && info.readsStdinAsCode) {
      push(ctx, 'pipe-to-shell', info.prog);
      if (pipelineHasDownloader) push(ctx, 'download-exec', info.prog);
    }
    if (info.prog && DOWNLOADERS.has(info.prog)) pipelineHasDownloader = true;
  });
  return parsed;
}

const RAW_DANGER: { rx: RegExp; code: ReasonCode; detail: string }[] = [
  { rx: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, code: 'fork-bomb', detail: ':(){ :|:& };:' },
  { rx: /\b([A-Za-z_]\w*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&/, code: 'fork-bomb', detail: 'recursive pipe function' },
  { rx: /--no-preserve-root/, code: 'root-delete', detail: '--no-preserve-root' },
  { rx: /\b(curl|wget|fetch)\b[^|;&\n]*\|\s*(sudo\s+(-\S+\s+)*)?(ba|z|da|k|c|tc|fi)?sh\b/, code: 'download-exec', detail: 'download | sh' },
  { rx: /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+(-\S+\s+)*)?(python[0-9.]*|perl|ruby|node|php)\b/, code: 'download-exec', detail: 'download | interpreter' },
  { rx: /\b(ba|z|da)?sh\b[^|;&\n]*(<\(|\$\(|`)\s*(curl|wget)\b/, code: 'download-exec', detail: 'sh <(curl …)' },
  { rx: /\bdrop\s+(database|schema|table|user|role|index)\b/i, code: 'database-destroy', detail: 'DROP' },
  { rx: /\btruncate\s+(table\s+)?[`"']?\w/i, code: 'database-destroy', detail: 'TRUNCATE' },
  { rx: /\bdelete\s+from\s+[`"']?[\w.]+[`"']?\s*(;|"|'|$)/im, code: 'database-destroy', detail: 'DELETE without WHERE' },
  { rx: /\bflushall\b|\bflushdb\b|\.dropDatabase\s*\(/i, code: 'database-destroy', detail: 'flush / dropDatabase' },
  { rx: /(^|[;&|\s])>\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk)/, code: 'device-overwrite', detail: '> /dev/disk' },
  { rx: /\bmkfs(\.\w+)?\b/, code: 'disk-destroy', detail: 'mkfs' },
  { rx: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|\bHISTFILE=\/dev\/null\b/, code: 'history-tamper', detail: 'history' },
];

function rawScan(ctx: Ctx, command: string) {
  for (const { rx, code, detail } of RAW_DANGER) if (rx.test(command)) push(ctx, code, detail);
  for (const src of ctx.opts.dangerPatterns ?? []) {
    try {
      if (src.trim() && new RegExp(src, 'i').test(command)) push(ctx, 'custom-danger', src);
    } catch {
      /* invalid user regex: ignore */
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

export function assessCommand(command: string, opts: ClassifierOptions = {}): CommandAssessment {
  const ctx: Ctx = {
    reasons: [],
    programs: [],
    opts,
    sensitivePatterns: opts.sensitivePaths?.length ? opts.sensitivePaths : DEFAULT_SENSITIVE_PATHS,
  };
  const trimmed = command.trim();
  if (!trimmed) {
    return { risk: 'block', sensitive: false, reasons: [{ code: 'empty' }], programs: [], simple: false };
  }
  const parsed = analyze(ctx, trimmed, 0);
  rawScan(ctx, trimmed);

  const codes = ctx.reasons.map((r) => r.code);
  let risk: RiskLevel = 'read';
  if (codes.some((c) => BLOCK_CODES.has(c))) risk = 'block';
  else if (codes.some((c) => DANGER_CODES.has(c))) risk = 'danger';
  else if (codes.some((c) => !NEUTRAL_CODES.has(c))) risk = 'write';

  const f = parsed.flags;
  const simple =
    parsed.segments.length === 1 &&
    parsed.inner.length === 0 &&
    !f.substitution && !f.processSubstitution && !f.background && !f.subshell && !f.group && !f.heredoc && !f.parseError &&
    parsed.segments[0].redirects.length === 0;

  return {
    risk,
    sensitive: codes.some((c) => NEUTRAL_CODES.has(c)),
    reasons: ctx.reasons,
    programs: [...new Set(ctx.programs)],
    simple,
  };
}

/** The command plus each of its simple commands — deny patterns are tested against all of them. */
export function commandParts(command: string): string[] {
  const parts = new Set<string>([normalizeCommand(command)]);
  const visit = (cmd: string, depth: number) => {
    const parsed = parseShell(cmd);
    for (const seg of parsed.segments) if (seg.words.length) parts.add(normalizeCommand(seg.words.join(' ')));
    if (depth < 3) for (const inner of parsed.inner) visit(inner, depth + 1);
  };
  visit(command, 0);
  return [...parts];
}

const REASON_TEXT: Record<ReasonCode, string> = {
  'parse-error': 'could not be parsed reliably',
  substitution: 'uses command substitution',
  'process-substitution': 'uses process substitution',
  background: 'starts a background job',
  subshell: 'uses a subshell',
  'redirect-write': 'writes to a file',
  heredoc: 'uses a here-document',
  'pipe-to-shell': 'pipes data into a shell or interpreter',
  interpreter: 'runs inline code or a script',
  sudo: 'runs with sudo (elevated privileges)',
  'unknown-program': 'is not a recognised read-only program',
  'modifying-args': 'uses arguments that modify state',
  'env-assignment': 'changes environment variables or shell state',
  'variable-command': 'runs a command whose name comes from a variable',
  'network-tool': 'makes network connections or transfers data',
  delete: 'deletes files',
  'recursive-delete': 'deletes files recursively or forcibly',
  'root-delete': 'would recursively delete a root or system directory',
  'device-overwrite': 'writes directly to a disk device',
  'disk-destroy': 'formats, partitions or wipes disks',
  power: 'shuts down, reboots or changes the system run state',
  firewall: 'changes firewall, network or security configuration',
  'ssh-lockout': 'could lock you out of SSH',
  'user-account': 'changes user accounts or passwords',
  'permissions-recursive': 'changes permissions or ownership broadly',
  'kill-processes': 'kills many processes',
  'package-remove': 'removes or replaces packages',
  'container-destroy': 'removes containers, images, volumes or cluster resources',
  'database-destroy': 'drops, truncates or wipes database data',
  'git-destructive': 'rewrites or discards git history or work',
  'infra-destroy': 'destroys or applies infrastructure without review',
  'history-tamper': 'erases shell history or logs',
  'system-file-write': 'modifies system files',
  'crontab-remove': 'removes the crontab',
  'fork-bomb': 'is a fork bomb',
  'download-exec': 'downloads and executes code',
  'sensitive-path': 'touches credential or secret files',
  'sensitive-command': 'prints environment variables that may contain secrets',
  'custom-danger': 'matches one of your danger patterns',
  'custom-block': 'matches one of your block patterns',
  empty: 'is empty',
};

export function describeReason(reason: Reason): string {
  const text = REASON_TEXT[reason.code] ?? reason.code;
  return reason.detail ? `${text} (${reason.detail})` : text;
}
