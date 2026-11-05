import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, SessionGrant } from '../../shared/types';

export type ApprovalInput = Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>;

export type ApprovalOutcome =
  | { allowed: true; decision: Extract<ApprovalDecision, { action: 'allow' }> }
  | { allowed: false; reason: 'denied' | 'timeout' | 'cancelled'; message?: string };

export interface TouchIdProvider {
  available(): boolean;
  prompt(reason: string): Promise<boolean>;
}

interface Pending {
  req: ApprovalRequest;
  resolve: (o: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  deciding: boolean;
}

export class ApprovalCenter extends EventEmitter {
  private pending = new Map<string, Pending>();
  private grants = new Map<string, SessionGrant>();

  constructor(private readonly touchId: TouchIdProvider) {
    super();
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req).sort((a, b) => a.createdAt - b.createdAt);
  }

  get count(): number {
    return this.pending.size;
  }

  request(input: ApprovalInput, timeoutSec: number, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const now = Date.now();
    const req: ApprovalRequest = { ...input, id: randomUUID(), createdAt: now, expiresAt: now + timeoutSec * 1000 };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(req.id, { allowed: false, reason: 'timeout' }), timeoutSec * 1000);
      const p: Pending = { req, resolve, timer, signal, deciding: false };
      if (signal) {
        p.onAbort = () => this.finish(req.id, { allowed: false, reason: 'cancelled', message: 'The AI client cancelled the request.' });
        signal.addEventListener('abort', p.onAbort, { once: true });
      }
      this.pending.set(req.id, p);
      this.emit('change');
      this.emit('request', req);
    });
  }

  private finish(id: string, outcome: ApprovalOutcome) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
    this.pending.delete(id);
    p.resolve(outcome);
    this.emit('change');
  }

  /** Called from the UI. Touch ID (or typing the host alias when Touch ID is unavailable) gates protected approvals. */
  async decide(id: string, decision: ApprovalDecision & { confirmText?: string }): Promise<{ ok: boolean; error?: string }> {
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: 'This request is no longer pending.' };
    if (decision.action === 'deny') {
      this.finish(id, { allowed: false, reason: 'denied', message: decision.message?.trim() || undefined });
      return { ok: true };
    }
    if (decision.scope === 'always' && !p.req.allowRemember) return { ok: false, error: 'This request cannot be remembered.' };
    if (p.deciding) return { ok: false, error: 'Already confirming.' };
    if (p.req.requireTouchId) {
      if (this.touchId.available()) {
        p.deciding = true;
        const target = p.req.command ?? p.req.path ?? '';
        const short = target.length > 60 ? target.slice(0, 57) + '…' : target;
        const ok = await this.touchId.prompt(`approve "${short}" on ${p.req.hostAlias}`);
        p.deciding = false;
        if (!ok) return { ok: false, error: 'Touch ID was not confirmed.' };
        if (!this.pending.has(id)) return { ok: false, error: 'The request expired while confirming.' };
      } else if ((decision.confirmText ?? '').trim().toLowerCase() !== p.req.hostAlias.toLowerCase()) {
        return { ok: false, error: 'type-confirm-required' };
      }
    }
    const { confirmText: _ignored, ...clean } = decision as Extract<ApprovalDecision, { action: 'allow' }> & { confirmText?: string };
    this.finish(id, { allowed: true, decision: clean });
    return { ok: true };
  }

  cancelAll(message: string) {
    for (const id of [...this.pending.keys()]) this.finish(id, { allowed: false, reason: 'cancelled', message });
  }

  // Session grants ------------------------------------------------------------

  grant(hostId: string, hostAlias: string, minutes: number) {
    this.grants.set(hostId, { hostId, hostAlias, expiresAt: Date.now() + minutes * 60_000 });
    this.emit('change');
  }

  revoke(hostId: string) {
    if (this.grants.delete(hostId)) this.emit('change');
  }

  revokeAll() {
    if (this.grants.size) {
      this.grants.clear();
      this.emit('change');
    }
  }

  grantActive(hostId: string): boolean {
    const g = this.grants.get(hostId);
    if (!g) return false;
    if (g.expiresAt <= Date.now()) {
      this.grants.delete(hostId);
      this.emit('change');
      return false;
    }
    return true;
  }

  listGrants(): SessionGrant[] {
    const now = Date.now();
    for (const [id, g] of this.grants) if (g.expiresAt <= now) this.grants.delete(id);
    return [...this.grants.values()];
  }
}
