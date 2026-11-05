// Append-only, hash-chained audit log (one JSONL file per month).
// Each line carries `prev` (hash of the previous line) and `hash`
// (sha256 over prev + the entry), so edits or deletions are detectable.

import { createHash, createHmac } from 'node:crypto';
import { promises as fsp, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditEntry } from '../../shared/types';
import { ensureDirSync } from '../fsutil';

const GENESIS = '0'.repeat(64);

export interface AuditQuery {
  limit?: number;
  offset?: number;
  host?: string;
  outcome?: string;
  tool?: string;
  text?: string;
  since?: number;
}

export interface AuditVerifyResult {
  ok: boolean;
  entries: number;
  files: number;
  brokenAt?: { file: string; line: number; reason: string };
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function chainHash(prev: string, body: string, key?: Buffer): string {
  const h = key ? createHmac('sha256', key) : createHash('sha256');
  return h.update(prev).update('\n').update(body).digest('hex');
}

export class AuditLog {
  private lastHash = GENESIS;
  private queue: Promise<void> = Promise.resolve();
  /** When set (vault-derived), the chain is HMAC-keyed so it cannot be forged without the vault key. */
  private key?: Buffer;

  constructor(private readonly dir: string) {
    ensureDirSync(dir);
    this.lastHash = this.readLastHash();
  }

  /** Supplies the HMAC key once the vault is unlocked. Safe to call repeatedly. */
  setKey(key: Buffer | undefined) {
    if (key) this.key = key;
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  private readLastHash(): string {
    const files = this.files();
    for (let i = files.length - 1; i >= 0; i--) {
      const lines = readFileSync(join(this.dir, files[i]), 'utf8').trimEnd().split('\n');
      for (let j = lines.length - 1; j >= 0; j--) {
        try {
          const obj = JSON.parse(lines[j]) as { hash?: string };
          if (obj.hash) return obj.hash;
        } catch {
          /* skip corrupt line */
        }
      }
    }
    return GENESIS;
  }

  append(entry: AuditEntry): Promise<void> {
    const body = JSON.stringify(entry);
    const prev = this.lastHash;
    const hash = chainHash(prev, body, this.key);
    this.lastHash = hash;
    const line = JSON.stringify({ ...entry, prev, hash }) + '\n';
    const file = join(this.dir, `${monthKey(entry.ts)}.jsonl`);
    this.queue = this.queue
      .then(() => fsp.appendFile(file, line, { mode: 0o600 }))
      .catch((err) => console.error('[gatehouse] audit write failed', err));
    return this.queue;
  }

  flush() {
    return this.queue;
  }

  private async readAll(newestFirst = true): Promise<AuditEntry[]> {
    const files = this.files();
    if (newestFirst) files.reverse();
    const out: AuditEntry[] = [];
    for (const f of files) {
      const text = await fsp.readFile(join(this.dir, f), 'utf8').catch(() => '');
      const lines = text.split('\n').filter(Boolean);
      if (newestFirst) lines.reverse();
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as AuditEntry & { prev?: string; hash?: string };
          delete obj.prev;
          delete obj.hash;
          out.push(obj);
        } catch {
          /* skip */
        }
      }
    }
    return out;
  }

  async query(q: AuditQuery = {}): Promise<{ entries: AuditEntry[]; total: number }> {
    await this.queue;
    const all = await this.readAll(true);
    const text = q.text?.trim().toLowerCase();
    const filtered = all.filter(
      (e) =>
        (!q.host || e.hostAlias === q.host) &&
        (!q.outcome || e.outcome === q.outcome) &&
        (!q.tool || e.tool === q.tool) &&
        (!q.since || e.ts >= q.since) &&
        (!text ||
          [e.command, e.path, e.reason, e.hostAlias, e.client, e.userMessage, e.error]
            .filter(Boolean)
            .some((s) => String(s).toLowerCase().includes(text))),
    );
    const offset = q.offset ?? 0;
    const limit = Math.min(q.limit ?? 200, 2000);
    return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  async recent(sinceTs: number): Promise<AuditEntry[]> {
    const all = await this.readAll(true);
    return all.filter((e) => e.ts >= sinceTs);
  }

  async verify(): Promise<AuditVerifyResult> {
    await this.queue;
    const files = this.files();
    let prev: string | null = null;
    let entries = 0;
    for (const f of files) {
      const lines = (await fsp.readFile(join(this.dir, f), 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          return { ok: false, entries, files: files.length, brokenAt: { file: f, line: i + 1, reason: 'unreadable line' } };
        }
        const { prev: p, hash, ...rest } = obj as { prev: string; hash: string };
        // The first surviving entry anchors the chain (older months may have been pruned).
        if (prev !== null && p !== prev) {
          return { ok: false, entries, files: files.length, brokenAt: { file: f, line: i + 1, reason: 'chain link mismatch (entry removed or reordered)' } };
        }
        if (chainHash(p, JSON.stringify(rest), this.key) !== hash) {
          return { ok: false, entries, files: files.length, brokenAt: { file: f, line: i + 1, reason: 'content was modified' } };
        }
        prev = hash;
        entries++;
      }
    }
    return { ok: true, entries, files: files.length };
  }

  prune(retentionDays: number) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const cutoffKey = monthKey(cutoff);
    for (const f of this.files()) {
      if (f.slice(0, 7) < cutoffKey) {
        try {
          unlinkSync(join(this.dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  }

  async exportTo(path: string, format: 'json' | 'csv') {
    const all = (await this.readAll(false)) as AuditEntry[];
    if (format === 'json') {
      await fsp.writeFile(path, JSON.stringify(all, null, 2));
      return;
    }
    const cols: (keyof AuditEntry)[] = [
      'ts', 'client', 'tool', 'hostAlias', 'command', 'path', 'risk', 'outcome', 'decidedBy', 'exitCode', 'durationMs',
      'redactions', 'reason', 'userMessage', 'error',
    ];
    const esc = (v: unknown) => {
      if (v === undefined || v === null) return '';
      let s = typeof v === 'number' && v > 1e12 ? new Date(v).toISOString() : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [cols.join(','), ...all.map((e) => cols.map((c) => esc(e[c])).join(','))];
    await fsp.writeFile(path, rows.join('\n'));
  }
}
