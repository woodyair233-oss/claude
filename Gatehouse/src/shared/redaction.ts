// Output sanitisation and redaction applied to everything the AI receives.
//
// Redaction is a privacy measure, not a security boundary: a model with
// shell access can always transform data (base64, rot13, …) so that no
// pattern matches. It reliably hides the identifiers Gatehouse knows about
// (saved hostnames, usernames) and common secret formats.

import type { RedactionSettings } from './types';

export type TokenKind = 'ip' | 'ipv6' | 'mac' | 'email' | 'host';

/** Stable, reversible placeholders shared by all MCP sessions of one app run. */
export class TokenMap {
  private forward = new Map<string, string>();
  private reverse = new Map<string, string>();
  private counters = new Map<string, number>();

  token(kind: TokenKind, value: string): string {
    const key = `${kind}:${value.toLowerCase()}`;
    let t = this.forward.get(key);
    if (!t) {
      const n = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, n);
      t = `[${kind}-${n}]`;
      this.forward.set(key, t);
      this.reverse.set(t, value);
    }
    return t;
  }

  /** Registers a fixed token such as `[host:web]`. */
  define(token: string, value: string) {
    this.reverse.set(token, value);
  }

  resolve(token: string): string | undefined {
    return this.reverse.get(token);
  }

  get size(): number {
    return this.reverse.size;
  }

  entries(): [string, string][] {
    return [...this.reverse.entries()];
  }

  clear() {
    this.forward.clear();
    this.reverse.clear();
    this.counters.clear();
  }
}

export interface Identity {
  alias: string;
  hostname: string;
  username: string;
  /** False for hosts hidden from the AI: they get opaque tokens instead of `[host:alias]`. */
  visible: boolean;
}

export interface RedactOptions {
  settings: RedactionSettings;
  identities: Identity[];
  tokens: TokenMap;
}

export interface RedactResult {
  text: string;
  count: number;
  kinds: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Sanitisation

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, and 2-char escapes.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][^\u001b]*\u001b\\|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// Bidi overrides/isolates and invisible formatting characters.
const INVISIBLE = /[‪-‮⁦-⁩‎‏؜​-‍⁠⁡-⁤﻿­]/g;
// Remaining C0/C1 controls except tab and newline.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Removes terminal control sequences and makes hidden characters visible. */
export function sanitizeOutput(text: string): string {
  return text
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(INVISIBLE, (ch) => `[U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`)
    .replace(CONTROL, (ch) => (ch === '\u0007' ? '' : `[^${ch.charCodeAt(0).toString(16).padStart(2, '0')}]`));
}

/** Keeps the start and the end of oversized output (errors usually live at the end). */
export function truncateMiddle(text: string, maxBytes: number): { text: string; truncated: boolean; omitted: number } {
  const bytes = byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false, omitted: 0 };
  const headChars = Math.floor(maxBytes * 0.4);
  const tailChars = Math.floor(maxBytes * 0.6);
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  const omitted = Math.max(0, bytes - byteLength(head) - byteLength(tail));
  return {
    text: `${head}\n\n… [Gatehouse: ${omitted.toLocaleString('en-US')} bytes omitted — narrow the command, e.g. with grep, head or tail] …\n\n${tail}`,
    truncated: true,
    omitted,
  };
}

function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Secret detectors

interface SecretRule {
  name: string;
  rx: RegExp;
  /** Replacement; `$<keep>` style groups are preserved via the function below. */
  keepPrefixGroup?: number;
}

const SECRET_RULES: SecretRule[] = [
  { name: 'private-key', rx: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END \1PRIVATE KEY(?: BLOCK)?-----/g },
  { name: 'aws-key-id', rx: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  { name: 'aws-secret', rx: /(aws_secret_access_key\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}/gi, keepPrefixGroup: 1 },
  { name: 'github', rx: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { name: 'gitlab', rx: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack', rx: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { name: 'anthropic', rx: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai', rx: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'stripe', rx: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'google-api', rx: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', rx: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'bearer', rx: /(authorization:\s*(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keepPrefixGroup: 1 },
  { name: 'url-credentials', rx: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@'"]+:[^/\s@'"]+@/gi, keepPrefixGroup: 1 },
];

// key = value / key: value where the key name suggests a secret.
const KEY_VALUE_SECRET =
  /(\b[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)(["']?)([^\s"',;]{4,})\2/gi;

const HIGH_ENTROPY_CANDIDATE = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,200}(?![A-Za-z0-9+/_=-])/g;

function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeRandomSecret(s: string): boolean {
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s)) return false;
  if (/^[A-Za-z]+$/.test(s.replace(/[-_/]/g, ''))) return false;
  if (s.includes('/') && s.split('/').length > 3) return false; // paths
  return shannon(s) >= 4.4;
}

// ---------------------------------------------------------------------------
// Network identifiers

const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)(?![\w-]*[A-Za-z])/g;
const MASK_OCTETS = new Set([0, 128, 192, 224, 240, 248, 252, 254, 255]);
const IPV6_CANDIDATE = /(?<![\w:.])(?:[0-9a-fA-F]{0,4}:){2,7}(?:[0-9a-fA-F]{0,4}|\d{1,3}(?:\.\d{1,3}){3})(?:%[\w.]+)?(?![\w:])/g;
const MAC = /(?<![\w:-])[0-9a-fA-F]{2}([:-])(?:[0-9a-fA-F]{2}\1){4}[0-9a-fA-F]{2}(?![\w:-])/g;
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w])/g;
const COMMON_USERS = new Set(['root', 'admin', 'ubuntu', 'debian', 'centos', 'ec2-user', 'pi', 'user', 'git', 'www-data', 'nobody', 'opc', 'azureuser', 'fedora', 'core', 'alpine']);

export function isPublicIpv4Token(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((o) => o > 255)) return false;
  if (a === 127 || (a === 0 && b === 0 && c === 0 && d === 0)) return false;
  if (a === 255 && MASK_OCTETS.has(b) && MASK_OCTETS.has(c) && MASK_OCTETS.has(d)) return false; // netmask
  if (a === 169 && b === 254 && c === 169 && d === 254) return false; // cloud metadata endpoint
  return true;
}

function isIpv6(candidate: string): boolean {
  const addr = candidate.replace(/%[\w.]+$/, '');
  if (addr === '::' || addr === '::1') return false;
  const parts = addr.split('::');
  if (parts.length > 2) return false;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = groups(parts[0]);
  const tail = parts.length === 2 ? groups(parts[1]) : [];
  const all = [...head, ...tail];
  let count = all.length;
  const last = all[all.length - 1];
  if (last && last.includes('.')) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(last)) return false;
    count += 1;
  }
  if (!all.every((g, i) => (i === all.length - 1 && g.includes('.')) || /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  if (parts.length === 2) return count < 8;
  return count === 8;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(input: string, { settings, identities, tokens }: RedactOptions): RedactResult {
  const kinds: Record<string, number> = {};
  let count = 0;
  const bump = (kind: string, n = 1) => {
    kinds[kind] = (kinds[kind] ?? 0) + n;
    count += n;
  };
  let text = input;

  if (settings.secrets) {
    for (const rule of SECRET_RULES) {
      text = text.replace(rule.rx, (...m: string[]) => {
        bump('secret');
        if (rule.name === 'private-key') return '[redacted private key]';
        return rule.keepPrefixGroup ? `${m[rule.keepPrefixGroup]}[redacted]` : '[redacted]';
      });
    }
    text = text.replace(KEY_VALUE_SECRET, (match, prefix: string, quote: string, value: string) => {
      if (/^\[redacted|^\[(ip|host|user|mac|email)/.test(value)) return match;
      if (/^(true|false|yes|no|none|null|on|off|required|optional|\*+|x+|<.*>|\$\{?\w+\}?)$/i.test(value)) return match;
      bump('secret');
      return `${prefix}${quote}[redacted]${quote}`;
    });
    text = text.replace(HIGH_ENTROPY_CANDIDATE, (match) => {
      if (!looksLikeRandomSecret(match)) return match;
      bump('secret');
      return '[redacted]';
    });
  }

  if (settings.hostIdentity) {
    // Longest values first so "db.example.com" wins over "example.com".
    const pairs: { value: string; token: string; kind: string }[] = [];
    for (const id of identities) {
      if (id.hostname) {
        const token = id.visible ? `[host:${id.alias}]` : tokens.token('host', id.hostname);
        tokens.define(token, id.hostname);
        pairs.push({ value: id.hostname, token, kind: 'host' });
      }
      if (id.username && id.username.length >= 3 && !COMMON_USERS.has(id.username.toLowerCase())) {
        const token = id.visible ? `[user:${id.alias}]` : '[user]';
        if (id.visible) tokens.define(token, id.username);
        pairs.push({ value: id.username, token, kind: 'user' });
      }
    }
    // Longest first; for equal values the earlier identity (the preferred host) wins.
    const seen = new Set<string>();
    const unique = pairs.filter((p) => {
      const key = `${p.kind}:${p.value.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    pairs.length = 0;
    pairs.push(...unique);
    pairs.sort((a, b) => b.value.length - a.value.length);
    for (const { value, token, kind } of pairs) {
      const rx = new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegex(value)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'gi');
      text = text.replace(rx, () => {
        bump(kind);
        return token;
      });
    }
  }

  if (settings.ipAddresses) {
    text = text.replace(IPV4, (match, a: string, b: string, c: string, d: string) => {
      if (!isPublicIpv4Token(+a, +b, +c, +d)) return match;
      bump('ip');
      return tokens.token('ip', match);
    });
    text = text.replace(IPV6_CANDIDATE, (match) => {
      if (!isIpv6(match)) return match;
      bump('ipv6');
      return tokens.token('ipv6', match);
    });
  }

  if (settings.macAddresses) {
    text = text.replace(MAC, (match) => {
      if (/^(00[:-]){5}00$/i.test(match) || /^(ff[:-]){5}ff$/i.test(match)) return match;
      bump('mac');
      return tokens.token('mac', match);
    });
  }

  if (settings.emails) {
    text = text.replace(EMAIL, (match) => {
      bump('email');
      return tokens.token('email', match);
    });
  }

  for (const rule of settings.customRules) {
    if (!rule.enabled || !rule.pattern) continue;
    let rx: RegExp;
    try {
      const flags = rule.flags.includes('g') ? rule.flags : rule.flags + 'g';
      rx = new RegExp(rule.pattern, flags);
    } catch {
      continue;
    }
    text = text.replace(rx, (...args: unknown[]) => {
      bump('custom');
      const groups = args.slice(1, -2) as string[];
      return (rule.replacement || '[redacted]').replace(/\$(\d)/g, (_m, i: string) => groups[Number(i) - 1] ?? '');
    });
  }

  return { text, count, kinds };
}

const TOKEN_RX = /\[(?:ip|ipv6|mac|email|host)-\d+\]|\[(?:host|user):[a-z0-9][a-z0-9-]*\]/g;

/** Replaces placeholders the AI copied from earlier output with the real values. */
export function detokenize(input: string, tokens: TokenMap): { text: string; replaced: string[]; unknown: string[] } {
  const replaced: string[] = [];
  const unknown: string[] = [];
  const text = input.replace(TOKEN_RX, (token) => {
    const value = tokens.resolve(token);
    if (value === undefined) {
      unknown.push(token);
      return token;
    }
    replaced.push(token);
    return value;
  });
  return { text, replaced, unknown };
}
