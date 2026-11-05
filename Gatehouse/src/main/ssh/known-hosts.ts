// Host key verification: Gatehouse's own pinned keys first, then the user's
// ~/.ssh/known_hosts (read-only) so existing trust carries over.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SystemKnownHostResult = 'match' | 'mismatch' | 'revoked' | 'unknown';

function hostPatternToRegex(pattern: string): RegExp {
  // Escape regex metacharacters including [ and ] so a non-default-port entry
  // like "[host]:2222" is matched literally, not read as a character class.
  const src = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${src}$`, 'i');
}

function hostMatchesField(field: string, host: string, port: number): boolean {
  const target = port === 22 ? host : `[${host}]:${port}`;
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    try {
      const digest = createHmac('sha1', Buffer.from(salt, 'base64')).update(target).digest('base64');
      return digest === hash;
    } catch {
      return false;
    }
  }
  let matched = false;
  for (const raw of field.split(',')) {
    const negate = raw.startsWith('!');
    const pat = negate ? raw.slice(1) : raw;
    if (hostPatternToRegex(pat).test(target)) {
      if (negate) return false;
      matched = true;
    }
  }
  return matched;
}

export function checkSystemKnownHosts(host: string, port: number, keyType: string, keyBase64: string, file?: string): SystemKnownHostResult {
  let content: string;
  try {
    content = readFileSync(file ?? join(homedir(), '.ssh', 'known_hosts'), 'utf8');
  } catch {
    return 'unknown';
  }
  let result: SystemKnownHostResult = 'unknown';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let marker = '';
    if (parts[0].startsWith('@')) marker = parts.shift()!;
    if (marker === '@cert-authority') continue;
    const [hosts, type, key] = parts;
    if (!hosts || !type || !key) continue;
    if (!hostMatchesField(hosts, host, port)) continue;
    if (marker === '@revoked') {
      if (key === keyBase64) return 'revoked';
      continue;
    }
    if (type === keyType) {
      if (key === keyBase64) return 'match';
      result = 'mismatch';
    }
  }
  return result;
}
