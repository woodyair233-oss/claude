// Non-interactive command execution for the AI gateway (exec channel, no PTY).

import type { Client } from 'ssh2';
import { assertSaneChannel } from './connection';

export interface ExecOptions {
  timeoutMs: number;
  /** Raw bytes kept per stream (head + tail) before sanitising/truncating. */
  captureBytes?: number;
  signal?: AbortSignal;
  /** Wrap with `bash -c` (fallback `sh -c`) so parsing does not depend on the login shell. */
  wrap?: boolean;
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

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const PID_MARKER = /\u001eGHPID:(\d+)\u001e/;

/**
 * Runs the command under bash when available so it is parsed the way
 * Gatehouse classified it, and reports the process-group id on stderr first
 * so a timed-out command can be killed even if the server ignores signals.
 */
export function wrapCommand(command: string): string {
  const q = shellQuote(command);
  const script = shellQuote(`printf '\\036GHPID:%s\\036' "$$" >&2; eval "$1"`);
  return `command -v bash >/dev/null 2>&1 && exec bash -c ${script} gatehouse ${q}; exec sh -c ${script} gatehouse ${q}`;
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

  text(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    if (!this.dropped) return head + tail;
    return `${head}\n… [${this.dropped.toLocaleString('en-US')} bytes not captured] …\n${tail}`;
  }
}

export function execCommand(client: Client, command: string, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const limit = opts.captureBytes ?? 4 * 1024 * 1024;
  const finalCommand = opts.wrap === false ? command : wrapCommand(command);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelled'));
    client.exec(finalCommand, (err, stream) => {
      if (err) return reject(err);
      try {
        assertSaneChannel(stream);
      } catch (e) {
        return reject(e);
      }
      const out = new Capture(limit);
      const errOut = new Capture(limit);
      const wrapped = opts.wrap !== false;
      let pid: number | undefined;
      let errHead: Buffer | null = wrapped ? Buffer.alloc(0) : null;
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
        const killGroup = () => {
          if (!pid) return;
          client.exec(`kill -TERM -- -${pid} 2>/dev/null; sleep 1; kill -KILL -- -${pid} 2>/dev/null; true`, (err, ch) => {
            if (err) return;
            ch.on('data', () => undefined);
            ch.stderr.on('data', () => undefined);
            ch.end();
          });
        };
        sig('INT');
        killTimers = [
          setTimeout(() => sig('TERM'), 1000),
          setTimeout(() => {
            sig('KILL');
            killGroup();
          }, 2500),
          setTimeout(() => {
            try {
              stream.close();
            } catch {
              /* ignore */
            }
          }, 5000),
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
      stream.stderr.on('data', (d: Buffer) => {
        if (errHead) {
          errHead = Buffer.concat([errHead, d]);
          const text = errHead.toString('latin1');
          const m = PID_MARKER.exec(text);
          if (m) {
            pid = Number(m[1]);
            const rest = Buffer.concat([errHead.subarray(0, m.index), errHead.subarray(m.index + m[0].length)]);
            errHead = null;
            if (rest.length) errOut.push(rest);
          } else if (errHead.length > 64) {
            errOut.push(errHead);
            errHead = null;
          }
          return;
        }
        errOut.push(d);
      });
      stream.on('exit', (code: number | null, signalName?: string) => {
        exitCode = typeof code === 'number' ? code : null;
        if (signalName) exitSignal = signalName;
      });
      stream.on('close', () => {
        if (done) return;
        done = true;
        if (errHead?.length) errOut.push(errHead);
        clearTimeout(timer);
        killTimers.forEach(clearTimeout);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({
          stdout: out.text(),
          stderr: errOut.text(),
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
      // No stdin for AI commands.
      stream.end();
    });
  });
}
