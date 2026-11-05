// Read-only import from ~/.ssh/config. We deliberately do NOT use
// ssh-config's compute(): it executes `Match exec` lines through a shell and
// performs blocking DNS lookups. Host blocks are resolved here with OpenSSH's
// first-match-wins semantics; Match blocks are ignored.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import SSHConfig from 'ssh-config';
import type { ImportCandidate } from '../../shared/types';

interface Section {
  patterns: string[];
  params: Record<string, string>;
}

const WANTED = ['hostname', 'user', 'port', 'identityfile', 'proxyjump'];

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function globToRegex(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${src}$`, 'i');
}

function matches(patterns: string[], alias: string): boolean {
  let ok = false;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const pat = neg ? raw.slice(1) : raw;
    if (globToRegex(pat).test(alias)) {
      if (neg) return false;
      ok = true;
    }
  }
  return ok;
}

function valueText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' && 'val' in x ? String((x as { val: unknown }).val) : String(x))).join(' ');
  return String(v ?? '');
}

function readSections(file: string, depth = 0, sections: Section[] = [], seen = new Set<string>(), inheritInto?: Section): Section[] {
  if (depth > 5 || seen.has(file)) return sections;
  seen.add(file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return sections;
  }
  const parsed = SSHConfig.parse(text) as unknown as { param: string; value: unknown; config?: unknown[] }[];
  // An Include is a textual insertion: leading params of an included file belong
  // to the section that was active at the Include point (passed as inheritInto),
  // not to a fresh global "*" — otherwise a Host-scoped Include leaks its
  // Port/User onto every host.
  let current: Section = inheritInto ?? { patterns: ['*'], params: {} };
  if (!inheritInto) sections.push(current);
  const handleInclude = (value: string, into: Section) => {
    for (const part of value.split(/\s+/).filter(Boolean)) {
      const full = isAbsolute(expandHome(part)) ? expandHome(part) : resolve(join(homedir(), '.ssh'), part);
      if (full.includes('*')) {
        try {
          const dir = dirname(full);
          const rx = globToRegex(full.slice(dir.length + 1));
          for (const f of readdirSync(dir).sort()) if (rx.test(f)) readSections(join(dir, f), depth + 1, sections, seen, into);
        } catch {
          /* ignore */
        }
      } else {
        readSections(full, depth + 1, sections, seen, into);
      }
    }
  };
  for (const line of parsed) {
    const param = String(line.param ?? '').toLowerCase();
    if (!param) continue;
    const value = valueText(line.value);
    if (param === 'include') {
      handleInclude(value, current);
      continue;
    }
    if (param === 'host' || param === 'match') {
      current = { patterns: param === 'host' ? value.split(/\s+/).filter(Boolean) : ['__match__'], params: {} };
      sections.push(current);
      const children = (line.config ?? []) as { param: string; value: unknown }[];
      for (const c of children) {
        const cp = String(c.param ?? '').toLowerCase();
        const cv = valueText(c.value);
        if (cp === 'include') handleInclude(cv, current);
        else if (WANTED.includes(cp) && !(cp in current.params)) current.params[cp] = cv;
      }
      continue;
    }
    if (WANTED.includes(param) && !(param in current.params)) current.params[param] = value;
  }
  return sections;
}

export function parseSshConfig(file = join(homedir(), '.ssh', 'config')): Omit<ImportCandidate, 'exists'>[] {
  const sections = readSections(file);
  const aliases = new Set<string>();
  for (const s of sections) for (const p of s.patterns) if (!/[*?!]/.test(p) && p !== '__match__') aliases.add(p);
  const out: Omit<ImportCandidate, 'exists'>[] = [];
  for (const alias of aliases) {
    const params: Record<string, string> = {};
    for (const s of sections) {
      if (s.patterns[0] === '__match__' || !matches(s.patterns, alias)) continue;
      for (const [k, v] of Object.entries(s.params)) if (!(k in params)) params[k] = v;
    }
    const port = Number(params.port ?? 22);
    out.push({
      alias,
      hostname: params.hostname ? params.hostname.replace(/%h/g, alias) : alias,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
      username: params.user ?? '',
      identityFile: params.identityfile ? expandHome(params.identityfile.replace(/^"|"$/g, '')) : undefined,
      proxyJump: params.proxyjump && params.proxyjump !== 'none' ? params.proxyjump : undefined,
    });
  }
  return out.sort((a, b) => a.alias.localeCompare(b.alias));
}
