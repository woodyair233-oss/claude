// Private Unix socket the gatehouse-mcp bridge connects to. Access control:
// the socket lives in a 0700 directory, is chmod 0600, and every connection
// must present a random token from the 0600 endpoint file.

import net from 'node:net';
import { PassThrough } from 'node:stream';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, unlinkSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ensureDirSync, writeFileAtomicSync } from '../fsutil';
import type { GatewayService } from './service';
import { createMcpServer } from './tools';

interface Hello {
  type: 'hello';
  protocol: number;
  token: string;
  bridgeVersion?: string;
  parentPid?: number;
  parentName?: string;
  clientLabel?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function prettyParent(name?: string): string | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  if (n === 'claude' || n.includes('claude code')) return 'Claude Code';
  if (n.includes('claude')) return 'Claude';
  if (n.includes('cursor')) return 'Cursor';
  if (n === 'code' || n.includes('visual studio code') || n.includes('electron')) return name;
  if (n === 'node' || n === 'bun') return undefined;
  return name;
}

export class McpSocketServer {
  private server?: net.Server;
  private token = '';
  private sockets = new Set<net.Socket>();

  constructor(
    private readonly gw: GatewayService,
    private readonly opts: { socketPath: string; endpointPath: string; appVersion: string },
  ) {}

  async start() {
    const { socketPath, endpointPath } = this.opts;
    const dir = dirname(socketPath);
    ensureDirSync(dir, 0o700);
    // Refuse a socket directory owned by someone else (relevant for the /tmp fallback).
    const st = lstatSync(dir);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error(`Socket directory ${dir} is owned by another user.`);
    }
    if (st.isSymbolicLink()) throw new Error(`Socket directory ${dir} is a symlink.`);
    if (existsSync(socketPath)) {
      // A live instance would hold the single-instance lock; anything left is stale.
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
    this.token = randomBytes(32).toString('hex');
    this.server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    writeFileAtomicSync(
      endpointPath,
      JSON.stringify({ socket: socketPath, token: this.token, pid: process.pid, appVersion: this.opts.appVersion, protocol: 1 }, null, 2),
      0o600,
    );
    this.gw.listening = true;
    this.gw.socketPath = socketPath;
    this.gw.error = undefined;
    this.server.on('error', (err) => {
      this.gw.error = err.message;
      this.gw.emit('change');
    });
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.server?.close();
    try {
      unlinkSync(this.opts.socketPath);
    } catch {
      /* ignore */
    }
    try {
      rmSync(this.opts.endpointPath, { force: true });
    } catch {
      /* ignore */
    }
    this.gw.listening = false;
  }

  private accept(sock: net.Socket) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => sock.destroy());
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), 5000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > 8192) sock.destroy();
        return;
      }
      sock.off('data', onData);
      clearTimeout(timer);
      const line = buf.subarray(0, nl).toString('utf8');
      const rest = buf.subarray(nl + 1);
      let hello: Hello;
      try {
        hello = JSON.parse(line) as Hello;
      } catch {
        sock.destroy();
        return;
      }
      if (hello?.type !== 'hello' || typeof hello.token !== 'string' || !safeEqual(hello.token, this.token)) {
        sock.end(JSON.stringify({ type: 'welcome', ok: false, error: 'authentication failed (restart the MCP client)' }) + '\n');
        return;
      }
      sock.write(JSON.stringify({ type: 'welcome', ok: true, appVersion: this.opts.appVersion }) + '\n');
      if (hello.clientLabel === 'doctor') {
        sock.end();
        return;
      }
      this.startSession(sock, hello, rest);
    };
    sock.on('data', onData);
  }

  private startSession(sock: net.Socket, hello: Hello, rest: Buffer) {
    const sessionId = randomUUID();
    const parent = prettyParent(hello.parentName);
    const label = hello.clientLabel === 'self-test' ? 'Gatehouse self-test' : hello.clientLabel || parent || 'MCP client';
    // Buffer bytes that arrived with the handshake and everything after it until
    // the transport attaches its reader.
    const input = new PassThrough();
    if (rest.length) input.write(rest);
    sock.pipe(input);
    const transport = new StdioServerTransport(input, sock, { maxBufferSize: 4 * 1024 * 1024 });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void handle.close().catch(() => undefined);
      sock.destroy();
      this.gw.removeSession(sessionId);
    };
    this.gw.addSession(
      { id: sessionId, clientName: label, parentName: parent, connectedAt: Date.now(), requestCount: 0 },
      close,
    );
    const handle = serveStdio(
      () =>
        createMcpServer(
          this.gw,
          { sessionId, clientName: () => this.gw.session(sessionId)?.clientName ?? label },
          this.opts.appVersion,
        ),
      { transport, onerror: (err) => console.warn('[gatehouse] mcp session error:', err.message) },
    );
    sock.on('close', close);
    input.on('end', () => {
      // Client closed stdin: give in-flight replies a moment, then close.
      setTimeout(close, 250);
    });
  }
}
