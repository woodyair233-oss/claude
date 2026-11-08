// Turns connection-log records into translated, user-facing text.

import type { ConnAttempt, ConnCause, ConnParams, ConnStep } from '@shared/types';
import { ALGO_KIND_LABEL, AUTH_METHOD_LABEL, CONN_ADDRESS_STEPS, CONN_CAUSE_HINTS, CONN_CAUSE_TITLE, CONN_DROP_TEXT, CONN_PROMPT_TEXT, CONN_STEP_TEXT } from '@shared/conn-text';
import { formatDateTime, formatDuration } from './format';
import { t } from './i18n';
import { api, useApp } from './store';

const DROP_TEXTS = new Set(Object.values(CONN_DROP_TEXT));

function methodLabel(m: string): string {
  return AUTH_METHOD_LABEL[m] ? t(AUTH_METHOD_LABEL[m]) : m;
}

/** Translates the parts of params that are words rather than data (method names, algorithm kinds…). */
function localize(params?: ConnParams): ConnParams {
  if (!params) return {};
  const out: ConnParams = { ...params };
  if (typeof out.method === 'string') out.method = methodLabel(out.method);
  if (typeof out.allowed === 'string') {
    out.allowed = out.allowed
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .map(methodLabel)
      .join(t(', '));
    if (!out.allowed) out.allowed = t('nothing');
  }
  if (typeof out.what === 'string' && ALGO_KIND_LABEL[out.what]) out.what = t(ALGO_KIND_LABEL[out.what]);
  if (typeof out.reason === 'string' && DROP_TEXTS.has(out.reason)) out.reason = t(out.reason);
  return out;
}

export function causeTitle(cause: ConnCause | undefined, params?: ConnParams): string {
  return t(CONN_CAUSE_TITLE[cause ?? 'unknown'] ?? CONN_CAUSE_TITLE.unknown, localize(params));
}

export function causeHints(cause: ConnCause | undefined, params?: ConnParams): string[] {
  const text = CONN_CAUSE_HINTS[cause ?? 'unknown'] ?? CONN_CAUSE_HINTS.unknown;
  return t(text, localize(params))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function stepText(step: ConnStep, attempt?: ConnAttempt): string {
  const params = localize(step.params);
  if (step.code === 'prompt') {
    const what = String(step.params?.what ?? '');
    return t(CONN_PROMPT_TEXT[what] ?? CONN_STEP_TEXT.prompt, params);
  }
  if (step.code === 'failed' && attempt?.cause) return causeTitle(attempt.cause, attempt.causeParams);
  return t(CONN_STEP_TEXT[step.code] ?? step.code, params);
}

export function stepShowsAddress(step: ConnStep): boolean {
  return CONN_ADDRESS_STEPS.has(step.code);
}

/** Which host-editor tab can fix a given cause. */
export function editorTabFor(cause: ConnCause | undefined): 'general' | 'auth' | 'advanced' {
  if (!cause) return 'general';
  if (cause.startsWith('auth-') || cause === 'agent-missing' || cause === 'key-missing' || cause === 'key-passphrase') return 'auth';
  if (cause === 'algorithms' || cause === 'algorithms-unsupported' || cause === 'dropped') return 'advanced';
  return 'general';
}

/** One-line headline for an attempt, for lists and toasts. */
export function attemptHeadline(a: ConnAttempt): string {
  if (a.outcome === 'connecting') return t('Connecting…');
  if (a.outcome === 'failed') return causeTitle(a.cause, a.causeParams);
  if (a.endCause === 'dropped') return t('Connected, then the connection was lost');
  return t('Connected');
}

/**
 * For an error from any host operation: if it came from a failed connection,
 * returns the translated diagnosis and the log entry that explains it.
 */
export async function explainConnError(hostId: string, err: unknown): Promise<{ title: string; attemptId?: string }> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const latest = await api().connLog.latest(hostId);
    if (latest && latest.outcome === 'failed' && latest.message === message && Date.now() - latest.startedAt < 10 * 60_000) {
      return { title: causeTitle(latest.cause, latest.causeParams), attemptId: latest.id };
    }
  } catch {
    /* fall back to the raw message */
  }
  return { title: message };
}

/** Error toast for a host operation, with a "View details" button when the connection failed. */
export async function hostErrorToast(hostId: string, title: string, err: unknown) {
  const { title: why, attemptId } = await explainConnError(hostId, err);
  const s = useApp.getState();
  s.toast({
    kind: 'error',
    title,
    message: why,
    action: attemptId ? { label: t('View details'), run: () => useApp.getState().openConnLog(hostId, attemptId) } : undefined,
  });
}

function mask(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 2) continue;
    out = out.split(s).join('[…]');
  }
  return out;
}

/** Plain-text report of one attempt, in the current language, for the clipboard. */
export function buildReport(a: ConnAttempt, opts: { includeAddresses: boolean; appVersion: string; platform: string }): string {
  const addressSecrets: string[] = [];
  if (!opts.includeAddresses) {
    addressSecrets.push(a.target.hostname);
    if (a.target.username) addressSecrets.push(a.target.username);
    for (const s of a.steps) {
      for (const k of ['addresses', 'address', 'name', 'user'] as const) {
        const v = s.params?.[k];
        if (typeof v === 'string') addressSecrets.push(...v.split(',').map((x) => x.replace('…', '').trim()));
      }
    }
    // Longest first, so a name is masked before the shorter strings inside it.
    addressSecrets.sort((x, y) => y.length - x.length);
  }
  const data = (s: string) => mask(s, addressSecrets);
  const target = `${a.target.username ? `${a.target.username}@` : ''}${a.target.hostname}:${a.target.port}`;
  const lines: string[] = [];
  lines.push(t('Gatehouse connection report'));
  lines.push(`${t('Host')}: ${data(a.hostLabel)} (${a.hostAlias})`);
  lines.push(`${t('Address')}: ${opts.includeAddresses ? target : t('(hidden)')}${a.via ? ` · ${t('Through jump host {jump}', { jump: a.via })}` : ''}`);
  lines.push(`${t('Time')}: ${formatDateTime(a.startedAt)}${a.durationMs !== undefined ? ` · ${formatDuration(a.durationMs)}` : ''} · ${a.initiatedBy === 'ai' ? t('Started by Claude') : t('Started by you')}`);
  lines.push(`${t('Result')}: ${attemptHeadline(a)}`);
  if (a.server) lines.push(`${t('Server software')}: ${a.server}`);
  if (a.outcome === 'failed' || a.endCause === 'dropped') {
    lines.push('', `${t('What you can do')}:`);
    for (const h of causeHints(a.outcome === 'failed' ? a.cause : 'dropped', a.causeParams)) lines.push(`- ${h}`);
  }
  lines.push('', `${t('Connection steps')}:`);
  for (const s of a.steps) {
    const mark = s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : '·';
    lines.push(`+${formatDuration(s.at).padEnd(7)} ${mark} ${data(stepText(s, a))}`);
  }
  if (a.error) lines.push('', `${t('Error')}: ${data(a.error)}`);
  if (a.log?.length) {
    lines.push('', `${t('Technical log')}:`);
    for (const l of a.log) lines.push(data(l));
  }
  lines.push('', `Gatehouse ${opts.appVersion} · ${opts.platform}`);
  return lines.join('\n');
}

export { formatDuration };
