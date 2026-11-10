// Non-interactive command execution for the AI gateway (exec channel, no PTY).

import type { Client } from 'ssh2';
import type { ShellTarget } from '../../shared/types';
import { assertSaneChannel } from './connection';
import { decodeClixml, decodeWindowsOutput, prepareExec, windowsKillCommands, type PreparedExec } from './windows';

export { shellQuote, wrapCommand } from './wrap';

export interface ExecOptions {
  timeoutMs: number;
  /** Raw bytes kept per stream (head + tail) before sanitising/truncating. */
  captureBytes?: number;
  signal?: AbortSignal;
  /** Wrap with `bash -c` (fallback `sh -c`) so parsing does not depend on the login shell. */
  wrap?: boolean;
  /** Where the command runs: POSIX bash/sh when omitted, or PowerShell / WSL on Windows. */
  shell?: ShellTarget;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal?: string;
  timedOut: boolean;
  aborted: boolean;
  /** Bytes dropped from the middle of either stream because of the capture cap. */
  droppedBytes: number;
  durationMs: number;
}

const MARKER = /\u001e(GHPID|GHLPID):(\d+)(?::(\d+))?\u001e/;
const MARKER_HEADS = ['\u001eGHPID:', '\u001eGHLPID:'];

function isMarkerPrefix(s: string): boolean {
  return MARKER_HEADS.some((head) => head.startsWith(s) || (s.startsWith(head) && /^\d*(:\d*)?$/.test(s.slice(head.length))));
}

/**
 * Removes the process-id markers the wrappers print on stderr (bash's process
 * group; on Windows the PowerShell process and console code page, and the
 * Linux process inside WSL) and passes everything else through.
 */
export class MarkerFilter {
  pid?: number;
  linuxPid?: number;
  codePage?: number;
  private pending = Buffer.alloc(0);
  private scanned = 0;
  private done = false;

  constructor(
    private readonly wantLinux: boolean,
    private readonly limit: number,
  ) {}

  push(chunk: Buffer): Buffer {
    if (this.done) return chunk;
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    this.scanned += chunk.length;
    const out: Buffer[] = [];
    for (let m = MARKER.exec(buf.toString('latin1')); m; m = MARKER.exec(buf.toString('latin1'))) {
      out.push(buf.subarray(0, m.index));
      if (m[1] === 'GHPID') {
        this.pid = Number(m[2]);
        if (m[3]) this.codePage = Number(m[3]);
      } else this.linuxPid = Number(m[2]);
      buf = buf.subarray(m.index + m[0].length);
    }
    const lastRs = buf.lastIndexOf(0x1e);
    if (lastRs >= 0 && buf.length - lastRs < 40 && isMarkerPrefix(buf.subarray(lastRs).toString('latin1'))) {
      this.pending = Buffer.from(buf.subarray(lastRs));
      buf = buf.subarray(0, lastRs);
    }
    out.push(buf);
    if ((this.pid !== undefined && (!this.wantLinux || this.linuxPid !== undefined)) || this.scanned > this.limit) {
      this.done = true;
      out.push(this.pending);
      this.pending = Buffer.alloc(0);
    }
    return Buffer.concat(out);
  }

  /** Bytes held back as a possible partial marker. */
  flush(): Buffer {
    const p = this.pending;
    this.pending = Buffer.alloc(0);
    this.done = true;
    return p;
  }
}

/** Head + rolling tail buffer with a fixed memory ceiling. */
class Capture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  dropped = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer) {
    if (!chunk.length) return;
    const half = this.limit / 2;
    if (this.headLen < half) {
      const take = Math.min(chunk.length, half - this.headLen);
      this.head.push(chunk.subarray(0, take));
      this.headLen += take;
      chunk = chunk.subarray(take);
      if (!chunk.length) return;
    }
    this.tail.push(chunk);
    this.tailLen += chunk.length;
    while (this.tailLen > half && this.tail.length) {
      const over = this.tailLen - half;
      const first = this.tail[0];
      if (first.length <= over) {
        this.tail.shift();
        this.tailLen -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailLen -= over;
        this.dropped += over;
      }
    }
  }

  text(decode: (b: Buffer) => string = (b) => b.toString('utf8')): string {
    const head = decode(Buffer.concat(this.head));
    const tail = decode(Buffer.concat(this.tail));
    if (!this.dropped) return head + tail;
    return `${head}\n… [${this.dropped.toLocaleString('en-US')} bytes not captured] …\n${tail}`;
  }
}

function runQuietly(client: Client, command: string) {
  try {
    client.exec(command, (err, ch) => {
      if (err) return;
      ch.on('data', () => undefined);
      ch.stderr.on('data', () => undefined);
      ch.end();
    });
  } catch {
    /* connection gone */
  }
}

export function execCommand(client: Client, command: string, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const limit = opts.captureBytes ?? 4 * 1024 * 1024;
  let prepared: PreparedExec;
  try {
    prepared = opts.wrap === false ? { command, windows: false } : prepareExec(opts.shell, command);
  } catch (err) {
    return Promise.reject(err);
  }
  const target = opts.shell ?? { kind: 'posix' as const };
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelled'));
    client.exec(prepared.command, (err, stream) => {
      if (err) return reject(err);
      try {
        assertSaneChannel(stream);
      } catch (e) {
        return reject(e);
      }
      const out = new Capture(limit);
      const errOut = new Capture(limit);
      const wrapped = opts.wrap !== false;
      const markers = wrapped ? new MarkerFilter(target.kind === 'wsl', prepared.windows ? 64 * 1024 : 4096) : undefined;
      let exitCode: number | null = null;
      let exitSignal: string | undefined;
      let timedOut = false;
      let aborted = false;
      let killTimers: NodeJS.Timeout[] = [];
      let done = false;

      const stop = () => {
        if (killTimers.length) return;
        // Closing the channel alone does not stop the remote process, so escalate signals first.
        // ssh2's Channel.signal() is a no-op after we sent EOF on stdin, but the protocol allows
        // channel requests after EOF, so send the request directly.
        const sig = (name: string) => {
          try {
            const proto = (client as unknown as { _protocol?: { signal(id: number, name: string): void } })._protocol;
            const outgoing = (stream as unknown as { outgoing?: { id: number; state: string } }).outgoing;
            if (proto && outgoing && outgoing.state !== 'closed') proto.signal(outgoing.id, name);
            else stream.signal(name);
          } catch {
            /* server may not support signals */
          }
        };
        const closeChannel = setTimeout(() => {
          try {
            stream.close();
          } catch {
            /* ignore */
          }
        }, 5000);
        if (prepared.windows) {
          // Windows OpenSSH ignores signals: stop the processes by id.
          const kill = windowsKillCommands(target, { win: markers?.pid, linux: markers?.linuxPid });
          if (kill.linux) runQuietly(client, kill.linux);
          killTimers = [setTimeout(() => kill.win && runQuietly(client, kill.win), kill.linux ? 2000 : 0), closeChannel];
          return;
        }
        const killGroup = () => {
          const pid = markers?.pid;
          if (pid) runQuietly(client, `kill -TERM -- -${pid} 2>/dev/null; sleep 1; kill -KILL -- -${pid} 2>/dev/null; true`);
        };
        sig('INT');
        killTimers = [
          setTimeout(() => sig('TERM'), 1000),
          setTimeout(() => {
            sig('KILL');
            killGroup();
          }, 2500),
          closeChannel,
        ];
      };

      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, opts.timeoutMs);
      const onAbort = () => {
        aborted = true;
        stop();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      stream.on('data', (d: Buffer) => out.push(d));
      stream.stderr.on('data', (d: Buffer) => errOut.push(markers ? markers.push(d) : d));
      stream.on('exit', (code: number | null, signalName?: string) => {
        exitCode = typeof code === 'number' ? code : null;
        if (signalName) exitSignal = signalName;
      });
      stream.on('close', () => {
        if (done) return;
        done = true;
        if (markers) errOut.push(markers.flush());
        clearTimeout(timer);
        killTimers.forEach(clearTimeout);
        opts.signal?.removeEventListener('abort', onAbort);
        const decode = prepared.windows ? (b: Buffer) => decodeWindowsOutput(b, markers?.codePage) : undefined;
        let stdout = out.text(decode);
        let stderr = errOut.text(decode);
        if (prepared.windows) {
          stdout = stdout.replace(/\r\n/g, '\n');
          stderr = decodeClixml(stderr).replace(/\r\n/g, '\n');
        }
        resolve({
          stdout,
          stderr,
          exitCode,
          exitSignal,
          timedOut,
          aborted,
          droppedBytes: out.dropped + errOut.dropped,
          durationMs: Date.now() - started,
        });
      });
      stream.on('error', (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        killTimers.forEach(clearTimeout);
        reject(e);
      });
      // AI commands get no stdin; a long Windows command is delivered on it.
      if (prepared.stdin) stream.end(prepared.stdin);
      else stream.end();
    });
  });
}
