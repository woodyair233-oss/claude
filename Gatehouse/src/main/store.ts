import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Host, KnownHostEntry, PortForward, Settings, Snippet, SshKeyInfo } from '../shared/types';
import { defaultAiPolicy, defaultSettings, newForward, newHost, newSnippet, sampleSnippets } from '../shared/defaults';
import { DebouncedWriter, readJsonSync } from './fsutil';

export interface StoreData {
  version: 1;
  hosts: Host[];
  keys: SshKeyInfo[];
  knownHosts: KnownHostEntry[];
  forwards: PortForward[];
  snippets: Snippet[];
  settings: Settings;
}

export type StoreSlice = 'hosts' | 'keys' | 'knownHosts' | 'forwards' | 'snippets' | 'settings';

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merges `patch` into `base`, ignoring keys `base` does not know (forward compatibility). */
export function mergeKnown<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base;
  const out: Plain = { ...(base as Plain) };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (isPlainObject(cur)) out[k] = mergeKnown(cur, v);
    else if (Array.isArray(cur)) out[k] = Array.isArray(v) ? v : cur;
    else if (typeof cur === typeof v || cur === undefined) out[k] = v;
  }
  return out as T;
}

function normalizeHost(raw: Partial<Host>): Host | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.hostname !== 'string') return null;
  const base = newHost({ id: raw.id });
  const host = mergeKnown(base, raw);
  // Optional fields that mergeKnown skips because the base lacks them.
  host.keyId = typeof raw.keyId === 'string' ? raw.keyId : undefined;
  host.jumpHostId = typeof raw.jumpHostId === 'string' ? raw.jumpHostId : undefined;
  host.lastConnectedAt = typeof raw.lastConnectedAt === 'number' ? raw.lastConnectedAt : undefined;
  host.osInfo = typeof raw.osInfo === 'string' ? raw.osInfo : undefined;
  host.ai = mergeKnown(defaultAiPolicy(), raw.ai);
  return host;
}

export class Store extends EventEmitter {
  data: StoreData;
  private writer: DebouncedWriter;

  constructor(private readonly path: string) {
    super();
    this.data = this.load();
    this.writer = new DebouncedWriter(path, () => JSON.stringify(this.data, null, 2));
  }

  private load(): StoreData {
    const raw = readJsonSync<Partial<StoreData>>(this.path);
    const fresh = !raw;
    const data: StoreData = {
      version: 1,
      hosts: (raw?.hosts ?? []).map(normalizeHost).filter((h): h is Host => !!h),
      keys: Array.isArray(raw?.keys) ? raw!.keys : [],
      knownHosts: Array.isArray(raw?.knownHosts) ? raw!.knownHosts : [],
      forwards: (raw?.forwards ?? [])
        .filter((f) => f && typeof f.id === 'string' && typeof f.hostId === 'string')
        .map((f) => mergeKnown(newForward({ id: f.id, hostId: f.hostId }), f)),
      snippets: (raw?.snippets ?? [])
        .filter((s) => s && typeof s.id === 'string')
        .map((s) => mergeKnown(newSnippet({ id: s.id }), s)),
      settings: mergeKnown(defaultSettings(), raw?.settings ?? {}),
    };
    if (fresh) data.snippets = sampleSnippets(() => randomUUID());
    return data;
  }

  private changed(slice: StoreSlice) {
    this.writer.schedule();
    this.emit('change', slice);
  }

  flush() {
    return this.writer.flush();
  }

  flushSync() {
    this.writer.flushSync();
  }

  // Hosts ---------------------------------------------------------------
  getHost(id: string): Host | undefined {
    return this.data.hosts.find((h) => h.id === id);
  }

  findHostByAlias(alias: string): Host | undefined {
    const a = alias.trim().toLowerCase();
    return this.data.hosts.find((h) => h.alias.toLowerCase() === a);
  }

  upsertHost(host: Host) {
    const i = this.data.hosts.findIndex((h) => h.id === host.id);
    if (i >= 0) this.data.hosts[i] = host;
    else this.data.hosts.push(host);
    this.changed('hosts');
  }

  patchHost(id: string, patch: Partial<Host>) {
    const h = this.getHost(id);
    if (!h) return;
    Object.assign(h, patch);
    this.changed('hosts');
  }

  deleteHost(id: string) {
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
    for (const h of this.data.hosts) if (h.jumpHostId === id) h.jumpHostId = undefined;
    const before = this.data.forwards.length;
    this.data.forwards = this.data.forwards.filter((f) => f.hostId !== id);
    this.changed('hosts');
    if (before !== this.data.forwards.length) this.changed('forwards');
  }

  // Keys ----------------------------------------------------------------
  getKey(id: string) {
    return this.data.keys.find((k) => k.id === id);
  }

  upsertKey(key: SshKeyInfo) {
    const i = this.data.keys.findIndex((k) => k.id === key.id);
    if (i >= 0) this.data.keys[i] = key;
    else this.data.keys.push(key);
    this.changed('keys');
  }

  deleteKey(id: string) {
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    for (const h of this.data.hosts) if (h.keyId === id) h.keyId = undefined;
    this.changed('keys');
    this.changed('hosts');
  }

  // Known hosts -----------------------------------------------------------
  findKnownHost(host: string, port: number) {
    const h = host.toLowerCase();
    return this.data.knownHosts.find((k) => k.host.toLowerCase() === h && k.port === port);
  }

  upsertKnownHost(entry: KnownHostEntry) {
    const i = this.data.knownHosts.findIndex((k) => k.id === entry.id);
    if (i >= 0) this.data.knownHosts[i] = entry;
    else this.data.knownHosts.push(entry);
    this.changed('knownHosts');
  }

  touchKnownHost(id: string) {
    const k = this.data.knownHosts.find((e) => e.id === id);
    if (!k) return;
    k.lastSeenAt = Date.now();
    this.changed('knownHosts');
  }

  deleteKnownHost(id: string) {
    this.data.knownHosts = this.data.knownHosts.filter((k) => k.id !== id);
    this.changed('knownHosts');
  }

  // Forwards ----------------------------------------------------------------
  getForward(id: string) {
    return this.data.forwards.find((f) => f.id === id);
  }

  upsertForward(f: PortForward) {
    const i = this.data.forwards.findIndex((x) => x.id === f.id);
    if (i >= 0) this.data.forwards[i] = f;
    else this.data.forwards.push(f);
    this.changed('forwards');
  }

  deleteForward(id: string) {
    this.data.forwards = this.data.forwards.filter((f) => f.id !== id);
    this.changed('forwards');
  }

  // Snippets ----------------------------------------------------------------
  getSnippet(id: string) {
    return this.data.snippets.find((s) => s.id === id);
  }

  upsertSnippet(s: Snippet) {
    const i = this.data.snippets.findIndex((x) => x.id === s.id);
    if (i >= 0) this.data.snippets[i] = s;
    else this.data.snippets.push(s);
    this.changed('snippets');
  }

  deleteSnippet(id: string) {
    this.data.snippets = this.data.snippets.filter((s) => s.id !== id);
    this.changed('snippets');
  }

  // Settings ------------------------------------------------------------------
  get settings(): Settings {
    return this.data.settings;
  }

  updateSettings(patch: unknown): Settings {
    this.data.settings = mergeKnown(this.data.settings, patch);
    this.changed('settings');
    return this.data.settings;
  }

  replaceAll(data: Partial<StoreData>) {
    if (data.hosts) this.data.hosts = data.hosts.map(normalizeHost).filter((h): h is Host => !!h);
    if (data.keys) this.data.keys = data.keys;
    if (data.knownHosts) this.data.knownHosts = data.knownHosts;
    if (data.forwards) this.data.forwards = data.forwards;
    if (data.snippets) this.data.snippets = data.snippets;
    if (data.settings) this.data.settings = mergeKnown(defaultSettings(), data.settings);
    for (const s of ['hosts', 'keys', 'knownHosts', 'forwards', 'snippets', 'settings'] as StoreSlice[]) this.changed(s);
  }
}
