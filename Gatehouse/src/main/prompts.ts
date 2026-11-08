import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PromptRequest, PromptResponse } from '../shared/types';

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type PromptInput = DistributiveOmit<PromptRequest, 'id'>;

interface Pending {
  req: PromptRequest;
  resolve: (r: PromptResponse) => void;
  timer: NodeJS.Timeout;
}

/** Interactive questions from the main process (host keys, passwords, 2FA) answered in the UI. */
export class PromptBroker extends EventEmitter {
  private pending = new Map<string, Pending>();

  /** Shows a question in the UI. Aborting `signal` withdraws it (answers it with null). */
  ask(input: PromptInput, timeoutMs = 180_000, signal?: AbortSignal): Promise<PromptResponse> {
    if (signal?.aborted) return Promise.resolve(null);
    const req = { ...input, id: randomUUID() } as PromptRequest;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(req.id, null), timeoutMs);
      this.pending.set(req.id, { req, resolve, timer });
      signal?.addEventListener('abort', () => this.finish(req.id, null), { once: true });
      this.emit('change');
      this.emit('ask', req);
    });
  }

  respond(id: string, response: PromptResponse) {
    this.finish(id, response);
  }

  private finish(id: string, response: PromptResponse) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(response);
    this.emit('change');
  }

  list(): PromptRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  cancelAll() {
    for (const id of [...this.pending.keys()]) this.finish(id, null);
  }
}
