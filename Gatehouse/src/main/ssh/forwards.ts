// Local (-L), remote (-R) and dynamic SOCKS5 (-D) port forwarding.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { ClientChannel, TcpConnectionDetails } from 'ssh2';
import type { ForwardStatus, PortForward } from '../../shared/types';
import type { ConnectionManager, Lease } from './connection';
import { isConnectError } from './diagnostics';

interface Running {
  forward: PortForward;
  lease: Lease;
  server?: net.Server;
  remoteHandler?: (info: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => void;
  sockets: Set<net.Socket | ClientChannel>;
}

function pipeCounted(a: net.Socket, b: ClientChannel, status: ForwardStatus, onChange: () => void) {
  a.on('data', (d: Buffer) => {
    status.bytesOut += d.length;
  });
  b.on('data', (d: Buffer) => {
    status.bytesIn += d.length;
  });
  a.pipe(b).pipe(a);
  const close = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', close);
  b.on('error', close);
  a.on('close', () => {
    close();
    onChange();
  });
}

/** Parses a SOCKS5 CONNECT request. Returns null while more bytes are needed. */
export function parseSocksRequest(buf: Buffer): { host: string; port: number; length: number } | { error: number } | null {
  if (buf.length < 5) return null;
  if (buf[0] !== 5) return { error: 1 };
  if (buf[1] !== 1) return { error: 7 }; // only CONNECT
  const atyp = buf[3];
  let host: string;
  let off: number;
  if (atyp === 1) {
    if (buf.length < 10) return null;
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    off = 8;
  } else if (atyp === 3) {
    const len = buf[4];
    if (buf.length < 5 + len + 2) return null;
    host = buf.subarray(5, 5 + len).toString('utf8');
    off = 5 + len;
  } else if (atyp === 4) {
    if (buf.length < 22) return null;
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
    host = parts.join(':');
    off = 20;
  } else {
    return { error: 8 };
  }
  return { host, port: buf.readUInt16BE(off), length: off + 2 };
}

export class ForwardManager extends EventEmitter {
  private running = new Map<string, Running>();
  /** Forwards whose start() is in progress (before `running` is set), to reject double-starts. */
  private starting = new Set<string>();
  private status = new Map<string, ForwardStatus>();
  private emitTimer?: NodeJS.Timeout;

  constructor(private readonly pool: ConnectionManager) {
    super();
    pool.on('closed', (hostId: string) => {
      for (const r of [...this.running.values()]) {
        if (r.forward.hostId !== hostId) continue;
        // Point at the connection-log entry, which says whether (and why) it dropped.
        const attemptId = r.lease.attemptId;
        const dropped = this.pool.connLog.get(attemptId)?.endCause === 'dropped';
        this.teardown(r.forward.id, 'Connection to the host closed', { attemptId, cause: dropped ? 'dropped' : undefined });
      }
    });
    // Remote forwards on a shared client: dispatch incoming connections.
  }

  statuses(): Record<string, ForwardStatus> {
    return Object.fromEntries(this.status.entries());
  }

  private changed() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit('change');
    }, 150);
  }

  private setStatus(id: string, patch: Partial<ForwardStatus>) {
    const cur = this.status.get(id) ?? { id, state: 'stopped', connections: 0, bytesIn: 0, bytesOut: 0 };
    this.status.set(id, { ...cur, ...patch });
    this.changed();
  }

  isRunning(id: string) {
    return this.running.has(id);
  }

  async start(forward: PortForward) {
    // Guard against overlapping start() calls: `running` is only set at the end,
    // so without a separate in-progress set the second call would bind the same
    // port, hit EADDRINUSE and wrongly mark the live tunnel as errored.
    if (this.running.has(forward.id) || this.starting.has(forward.id)) return;
    this.starting.add(forward.id);
    this.setStatus(forward.id, { state: 'starting', error: undefined, cause: undefined, causeParams: undefined, attemptId: undefined, connections: 0, bytesIn: 0, bytesOut: 0 });
    let lease: Lease | undefined;
    try {
      lease = await this.pool.acquire(forward.hostId, 'user');
      const r: Running = { forward, lease, sockets: new Set() };
      const st = this.status.get(forward.id)!;
      if (forward.type === 'remote') {
        await new Promise<void>((resolve, reject) =>
          lease!.client.forwardIn(forward.bindAddress, forward.bindPort, (err) => (err ? reject(err) : resolve())),
        );
        r.remoteHandler = (info, accept, reject) => {
          if (info.destPort !== forward.bindPort) return;
          const channel = accept();
          const sock = net.connect(forward.destPort, forward.destHost || '127.0.0.1');
          st.connections++;
          this.changed();
          r.sockets.add(sock);
          pipeCounted(sock, channel, st, () => {
            r.sockets.delete(sock);
            st.connections = Math.max(0, st.connections - 1);
            this.changed();
          });
          sock.on('error', () => reject);
        };
        lease.client.on('tcp connection', r.remoteHandler);
      } else {
        const server = net.createServer((sock) => {
          sock.on('error', () => sock.destroy());
          if (forward.type === 'local') {
            this.openChannel(r, sock, forward.destHost || '127.0.0.1', forward.destPort, st);
          } else {
            this.handleSocks(r, sock, st);
          }
        });
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(forward.bindPort, forward.bindAddress, () => {
            server.off('error', reject);
            resolve();
          });
        });
        server.on('error', (e) => this.teardown(forward.id, e.message));
        r.server = server;
      }
      this.running.set(forward.id, r);
      this.setStatus(forward.id, { state: 'running', startedAt: Date.now() });
    } catch (err) {
      lease?.release();
      if (isConnectError(err)) {
        this.setStatus(forward.id, { state: 'error', error: err.message, cause: err.connCause, causeParams: err.connParams, attemptId: err.attemptId });
        throw err;
      }
      const e = err as NodeJS.ErrnoException;
      const msg = e.code === 'EADDRINUSE' ? `Port ${forward.bindPort} is already in use.` : e.code === 'EACCES' ? `No permission to listen on port ${forward.bindPort}.` : e.message;
      this.setStatus(forward.id, { state: 'error', error: msg });
      throw new Error(msg);
    } finally {
      this.starting.delete(forward.id);
    }
  }

  private openChannel(r: Running, sock: net.Socket, host: string, port: number, st: ForwardStatus, onReady?: () => void, onFail?: () => void) {
    r.lease.client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, host, port, (err, channel) => {
      if (err) {
        onFail?.();
        sock.destroy();
        return;
      }
      onReady?.();
      st.connections++;
      this.changed();
      r.sockets.add(sock);
      pipeCounted(sock, channel, st, () => {
        r.sockets.delete(sock);
        st.connections = Math.max(0, st.connections - 1);
        this.changed();
      });
    });
  }

  private handleSocks(r: Running, sock: net.Socket, st: ForwardStatus) {
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'request' = 'greeting';
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024) return sock.destroy();
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return sock.destroy();
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0)) {
          sock.end(Buffer.from([5, 0xff]));
          return;
        }
        sock.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        const req = parseSocksRequest(buf);
        if (!req) return;
        sock.off('data', onData);
        if ('error' in req) {
          sock.end(Buffer.from([5, req.error, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const rest = buf.subarray(req.length);
        sock.pause();
        this.openChannel(
          r,
          sock,
          req.host,
          req.port,
          st,
          () => {
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (rest.length) sock.unshift(rest);
            sock.resume();
          },
          () => {
            sock.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          },
        );
      }
    };
    sock.on('data', onData);
  }

  stop(id: string) {
    this.teardown(id);
  }

  private teardown(id: string, error?: string, diag?: Pick<ForwardStatus, 'attemptId' | 'cause'>) {
    const r = this.running.get(id);
    if (r) {
      this.running.delete(id);
      r.server?.close();
      if (r.remoteHandler) {
        r.lease.client.off('tcp connection', r.remoteHandler);
        try {
          r.lease.client.unforwardIn(r.forward.bindAddress, r.forward.bindPort);
        } catch {
          /* connection may be gone */
        }
      }
      for (const s of r.sockets) s.destroy();
      r.lease.release();
    }
    this.setStatus(id, { state: error ? 'error' : 'stopped', error, connections: 0, attemptId: diag?.attemptId, cause: diag?.cause, causeParams: undefined });
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.teardown(id);
  }

  forget(id: string) {
    this.teardown(id);
    this.status.delete(id);
    this.changed();
  }
}
