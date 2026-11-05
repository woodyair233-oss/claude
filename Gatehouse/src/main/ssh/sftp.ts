import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { basename, join as localJoin, resolve as localResolve, sep as localSep } from 'node:path';
import { posix } from 'node:path';
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import type { SftpEntry, TransferInfo } from '../../shared/types';
import type { ConnectionManager, Initiator, Lease } from './connection';
import { assertSaneChannel } from './connection';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const IDLE_MS = 90_000;

export function modeType(mode: number): SftpEntry['type'] {
  const t = mode & S_IFMT;
  if (t === S_IFDIR) return 'dir';
  if (t === S_IFREG) return 'file';
  if (t === S_IFLNK) return 'link';
  return 'other';
}

export function permissionString(mode: number): string {
  const t = modeType(mode);
  const prefix = t === 'dir' ? 'd' : t === 'link' ? 'l' : t === 'file' ? '-' : '?';
  const bits = ['r', 'w', 'x'];
  let s = prefix;
  for (let i = 8; i >= 0; i--) s += mode & (1 << i) ? bits[(8 - i) % 3] : '-';
  return s;
}

interface CachedSftp {
  lease: Lease;
  sftp: SFTPWrapper;
  timer?: NodeJS.Timeout;
  users: number;
}

interface TransferState {
  info: TransferInfo;
  cancel?: () => void;
}

const p = <T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))));

export class SftpManager extends EventEmitter {
  private cache = new Map<string, Promise<CachedSftp>>();
  private transfers = new Map<string, TransferState>();
  private emitTimer?: NodeJS.Timeout;

  constructor(private readonly pool: ConnectionManager) {
    super();
    pool.on('closed', (hostId: string) => this.cache.delete(hostId));
  }

  private open(hostId: string, initiatedBy: Initiator): Promise<CachedSftp> {
    const promise: Promise<CachedSftp> = (async () => {
      const lease = await this.pool.acquire(hostId, initiatedBy);
      try {
        const sftp = await p<SFTPWrapper>((cb) => lease.client.sftp(cb));
        assertSaneChannel(sftp);
        sftp.on('close', () => {
          lease.release();
          if (this.cache.get(hostId) === promise) this.cache.delete(hostId);
        });
        return { lease, sftp, users: 0 };
      } catch (err) {
        lease.release();
        throw err;
      }
    })();
    return promise;
  }

  /** Runs `fn` with a cached SFTP channel for the host. */
  async with<T>(hostId: string, initiatedBy: Initiator, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    let entry = this.cache.get(hostId);
    if (!entry) {
      entry = this.open(hostId, initiatedBy);
      this.cache.set(hostId, entry);
      entry.catch(() => this.cache.delete(hostId));
    }
    const c = await entry;
    c.users++;
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = undefined;
    }
    try {
      return await fn(c.sftp);
    } finally {
      c.users--;
      if (c.users === 0) {
        c.timer = setTimeout(() => {
          if (this.cache.get(hostId) === entry) this.cache.delete(hostId);
          try {
            c.sftp.end();
          } catch {
            /* ignore */
          }
        }, IDLE_MS);
      }
    }
  }

  home(hostId: string, initiatedBy: Initiator = 'user'): Promise<string> {
    return this.with(hostId, initiatedBy, (sftp) => p<string>((cb) => sftp.realpath('.', cb)));
  }

  async list(hostId: string, dir: string, initiatedBy: Initiator = 'user'): Promise<{ path: string; entries: SftpEntry[] }> {
    return this.with(hostId, initiatedBy, async (sftp) => {
      const path = await p<string>((cb) => sftp.realpath(dir || '.', cb));
      const list = await p<FileEntryWithStats[]>((cb) => sftp.readdir(path, cb));
      const entries: SftpEntry[] = await Promise.all(
        list.map(async (f) => {
          const full = posix.join(path, f.filename);
          const fields = f.longname.split(/\s+/);
          const entry: SftpEntry = {
            name: f.filename,
            path: full,
            type: modeType(f.attrs.mode),
            size: f.attrs.size,
            mtime: f.attrs.mtime * 1000,
            mode: f.attrs.mode,
            permissions: permissionString(f.attrs.mode),
            owner: fields[2],
            group: fields[3],
          };
          if (entry.type === 'link') {
            try {
              entry.linkTarget = await p<string>((cb) => sftp.readlink(full, cb));
              const st = await p<Stats>((cb) => sftp.stat(full, cb));
              if (st.isDirectory()) entry.type = 'dir';
              entry.linkTarget = entry.linkTarget || undefined;
            } catch {
              /* dangling link */
            }
          }
          return entry;
        }),
      );
      entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
      return { path, entries };
    });
  }

  stat(hostId: string, path: string, initiatedBy: Initiator = 'user'): Promise<Stats> {
    return this.with(hostId, initiatedBy, (sftp) => p<Stats>((cb) => sftp.stat(path, cb)));
  }

  mkdir(hostId: string, path: string) {
    return this.with(hostId, 'user', (sftp) => p<void>((cb) => sftp.mkdir(path, cb)));
  }

  rename(hostId: string, from: string, to: string) {
    return this.with(hostId, 'user', (sftp) => p<void>((cb) => sftp.rename(from, to, cb)));
  }

  chmod(hostId: string, path: string, mode: number) {
    return this.with(hostId, 'user', (sftp) => p<void>((cb) => sftp.chmod(path, mode, cb)));
  }

  async remove(hostId: string, paths: string[]) {
    await this.with(hostId, 'user', async (sftp) => {
      const rm = async (path: string): Promise<void> => {
        const st = await p<Stats>((cb) => sftp.lstat(path, cb));
        if (st.isDirectory()) {
          const children = await p<FileEntryWithStats[]>((cb) => sftp.readdir(path, cb));
          for (const c of children) await rm(posix.join(path, c.filename));
          await p<void>((cb) => sftp.rmdir(path, cb));
        } else {
          await p<void>((cb) => sftp.unlink(path, cb));
        }
      };
      for (const path of paths) {
        if (path === '/' || path === '') throw new Error('Refusing to delete the root directory.');
        await rm(path);
      }
    });
  }

  /** Reads up to `maxBytes` starting at `offset`. */
  async readFile(hostId: string, path: string, opts: { offset?: number; maxBytes: number; initiatedBy: Initiator }) {
    return this.with(hostId, opts.initiatedBy, async (sftp) => {
      const st = await p<Stats>((cb) => sftp.stat(path, cb));
      if (st.isDirectory()) throw new Error('That path is a directory.');
      const offset = Math.max(0, Math.min(opts.offset ?? 0, st.size));
      const length = Math.max(0, Math.min(opts.maxBytes, st.size - offset));
      const handle = await p<Buffer>((cb) => sftp.open(path, 'r', cb));
      try {
        const buf = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const n = await new Promise<number>((resolve, reject) =>
            sftp.read(handle, buf, read, Math.min(length - read, 64 * 1024), offset + read, (err, bytes) =>
              err ? reject(err) : resolve(bytes),
            ),
          );
          if (!n) break;
          read += n;
        }
        return { data: buf.subarray(0, read), size: st.size, offset, mtime: st.mtime * 1000 };
      } finally {
        sftp.close(handle, () => undefined);
      }
    });
  }

  async writeFile(hostId: string, path: string, data: Buffer, opts: { append?: boolean; initiatedBy: Initiator }) {
    return this.with(hostId, opts.initiatedBy, async (sftp) => {
      const flag = opts.append ? 'a' : 'w';
      await new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(path, { flags: flag });
        ws.on('error', reject);
        ws.on('close', () => resolve());
        ws.end(data);
      });
    });
  }

  // Transfers -----------------------------------------------------------------

  listTransfers(): TransferInfo[] {
    return [...this.transfers.values()].map((t) => t.info).sort((a, b) => b.startedAt - a.startedAt);
  }

  clearFinished() {
    for (const [id, t] of this.transfers) if (t.info.state !== 'running' && t.info.state !== 'queued') this.transfers.delete(id);
    this.emit('change');
  }

  cancel(id: string) {
    const t = this.transfers.get(id);
    if (!t || (t.info.state !== 'running' && t.info.state !== 'queued')) return;
    t.cancel?.();
    t.info = { ...t.info, state: 'cancelled', finishedAt: Date.now() };
    this.emitChange();
  }

  private emitChange() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit('change');
    }, 120);
  }

  private newTransfer(hostId: string, direction: 'upload' | 'download', localPath: string, remotePath: string, total: number): TransferState {
    const t: TransferState = {
      info: {
        id: randomUUID(),
        hostId,
        direction,
        name: direction === 'upload' ? basename(localPath) : posix.basename(remotePath),
        localPath,
        remotePath,
        totalBytes: total,
        transferredBytes: 0,
        state: 'queued',
        startedAt: Date.now(),
      },
    };
    this.transfers.set(t.info.id, t);
    this.emitChange();
    return t;
  }

  private runStream(t: TransferState, src: NodeJS.ReadableStream & { destroy(): void }, dst: NodeJS.WritableStream & { destroy(): void }) {
    return new Promise<void>((resolve) => {
      t.info = { ...t.info, state: 'running' };
      let finished = false;
      const finish = (state: TransferInfo['state'], error?: string) => {
        if (finished) return;
        finished = true;
        if (t.info.state !== 'cancelled') t.info = { ...t.info, state, error, finishedAt: Date.now() };
        this.emitChange();
        resolve();
      };
      t.cancel = () => {
        src.destroy();
        dst.destroy();
        finish('cancelled');
      };
      src.on('data', (chunk: Buffer) => {
        t.info.transferredBytes += chunk.length;
        this.emitChange();
      });
      src.on('error', (e: Error) => finish('error', e.message));
      dst.on('error', (e: Error) => finish('error', e.message));
      dst.on('close', () => finish('done'));
      src.pipe(dst);
    });
  }

  async upload(hostId: string, localPaths: string[], remoteDir: string) {
    await this.with(hostId, 'user', async (sftp) => {
      const jobs: { local: string; remote: string; size: number }[] = [];
      const walk = async (local: string, remote: string) => {
        const st = await fsp.stat(local);
        if (st.isDirectory()) {
          await p<void>((cb) => sftp.mkdir(remote, cb)).catch(() => undefined);
          for (const child of await fsp.readdir(local)) await walk(localJoin(local, child), posix.join(remote, child));
        } else if (st.isFile()) {
          jobs.push({ local, remote, size: st.size });
        }
      };
      for (const lp of localPaths) await walk(lp, posix.join(remoteDir, basename(lp)));
      const states = jobs.map((j) => ({ j, t: this.newTransfer(hostId, 'upload', j.local, j.remote, j.size) }));
      for (const { j, t } of states) {
        if (t.info.state === 'cancelled') continue;
        await this.runStream(t, createReadStream(j.local), sftp.createWriteStream(j.remote) as never);
      }
    });
  }

  async download(hostId: string, remotePaths: string[], localDir: string) {
    const root = localResolve(localDir);
    // A malicious or buggy server controls the names returned by readdir; join
    // them defensively so a name like "../../x" cannot escape the chosen folder.
    const safeJoin = (base: string, name: string): string => {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
        throw new Error(`Refusing unsafe filename from server: ${JSON.stringify(name).slice(0, 80)}`);
      }
      const full = localResolve(base, name);
      if (full !== root && !full.startsWith(root + localSep)) {
        throw new Error('Refusing to write a downloaded file outside the chosen folder.');
      }
      return full;
    };
    await this.with(hostId, 'user', async (sftp) => {
      const jobs: { local: string; remote: string; size: number }[] = [];
      const walk = async (remote: string, local: string) => {
        const st = await p<Stats>((cb) => sftp.stat(remote, cb));
        if (st.isDirectory()) {
          await fsp.mkdir(local, { recursive: true });
          const children = await p<FileEntryWithStats[]>((cb) => sftp.readdir(remote, cb));
          for (const c of children) await walk(posix.join(remote, c.filename), safeJoin(local, c.filename));
        } else {
          jobs.push({ local, remote, size: st.size });
        }
      };
      await fsp.mkdir(root, { recursive: true });
      for (const rp of remotePaths) await walk(rp, safeJoin(root, posix.basename(rp)));
      const states = jobs.map((j) => ({ j, t: this.newTransfer(hostId, 'download', j.local, j.remote, j.size) }));
      for (const { j, t } of states) {
        if (t.info.state === 'cancelled') continue;
        await this.runStream(t, sftp.createReadStream(j.remote) as never, createWriteStream(j.local));
      }
    });
  }
}
