// Interactive PTY sessions streamed to xterm.js with flow control.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ClientChannel } from 'ssh2';
import type { TerminalSessionInfo } from '../../shared/types';
import type { ConnectionManager, Lease } from './connection';
import { assertSaneChannel } from './connection';

const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 256 * 1024;
const FLUSH_MS = 6;

interface Session {
  info: TerminalSessionInfo;
  lease?: Lease;
  stream?: ClientChannel;
  pending: Buffer[];
  pendingLen: number;
  flushTimer?: NodeJS.Timeout;
  unacked: number;
  paused: boolean;
  cols: number;
  rows: number;
}

export interface TerminalSink {
  data(id: string, data: Uint8Array): void;
}

export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly pool: ConnectionManager,
    private readonly sink: TerminalSink,
  ) {
    super();
    pool.on('closed', (hostId: string) => {
      for (const s of this.sessions.values()) {
        if (s.info.hostId === hostId && s.info.state === 'connected') this.markClosed(s, 'Connection closed');
      }
    });
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  open(hostId: string, title: string, cols: number, rows: number, startupCommand?: string): string {
    const id = randomUUID();
    const session: Session = {
      info: { id, hostId, title, state: 'connecting', startedAt: Date.now() },
      pending: [],
      pendingLen: 0,
      unacked: 0,
      paused: false,
      cols: Math.max(2, cols | 0),
      rows: Math.max(2, rows | 0),
    };
    this.sessions.set(id, session);
    this.emit('change');
    void this.start(session, startupCommand);
    return id;
  }

  private async start(s: Session, startupCommand?: string) {
    try {
      s.lease = await this.pool.acquire(s.info.hostId, 'user');
      if (!this.sessions.has(s.info.id)) {
        s.lease.release();
        return;
      }
      const stream = await new Promise<ClientChannel>((resolve, reject) =>
        s.lease!.client.shell({ term: 'xterm-256color', cols: s.cols, rows: s.rows }, (err, ch) => {
          if (err) return reject(err);
          try {
            assertSaneChannel(ch);
          } catch (e) {
            return reject(e);
          }
          resolve(ch);
        }),
      );
      s.stream = stream;
      s.info = { ...s.info, state: 'connected', error: undefined };
      this.emit('change');
      const onData = (d: Buffer) => this.queue(s, d);
      stream.on('data', onData);
      stream.stderr.on('data', onData);
      stream.on('close', () => this.markClosed(s));
      if (startupCommand?.trim()) stream.write(startupCommand.trim() + '\n');
    } catch (err) {
      s.info = { ...s.info, state: 'error', error: (err as Error).message };
      s.lease?.release();
      s.lease = undefined;
      this.emit('change');
    }
  }

  private queue(s: Session, d: Buffer) {
    s.pending.push(d);
    s.pendingLen += d.length;
    s.unacked += d.length;
    if (!s.paused && s.unacked > HIGH_WATER) {
      s.paused = true;
      s.stream?.pause();
    }
    if (!s.flushTimer) s.flushTimer = setTimeout(() => this.flush(s), FLUSH_MS);
  }

  private flush(s: Session) {
    s.flushTimer = undefined;
    if (!s.pendingLen) return;
    const data = s.pending.length === 1 ? s.pending[0] : Buffer.concat(s.pending, s.pendingLen);
    s.pending = [];
    s.pendingLen = 0;
    this.sink.data(s.info.id, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  ack(id: string, bytes: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.unacked = Math.max(0, s.unacked - bytes);
    if (s.paused && s.unacked < LOW_WATER) {
      s.paused = false;
      s.stream?.resume();
    }
  }

  write(id: string, data: string) {
    const s = this.sessions.get(id);
    if (s?.stream && s.info.state === 'connected') s.stream.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.cols = Math.max(2, cols | 0);
    s.rows = Math.max(2, rows | 0);
    if (s.stream && s.info.state === 'connected') s.stream.setWindow(s.rows, s.cols, 0, 0);
  }

  rename(id: string, title: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.info = { ...s.info, title: title.slice(0, 80) };
    this.emit('change');
  }

  reconnect(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.info.state === 'connecting' || s.info.state === 'connected') return;
    s.info = { ...s.info, state: 'connecting', error: undefined };
    s.unacked = 0;
    s.paused = false;
    this.emit('change');
    void this.start(s);
  }

  private markClosed(s: Session, error?: string) {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      this.flush(s);
    }
    if (s.info.state === 'closed') return;
    s.info = { ...s.info, state: error ? 'error' : 'closed', error };
    s.stream = undefined;
    s.lease?.release();
    s.lease = undefined;
    this.emit('change');
  }

  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      s.stream?.close();
    } catch {
      /* ignore */
    }
    s.lease?.release();
    s.lease = undefined;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    this.emit('change');
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.info.state === 'connected').length;
  }
}
