// Turns connection-log records into translated, user-facing text.

import type { ConnAttempt, ConnCause, ConnParams, ConnStep } from '@shared/types';
import {
  ALGO_KIND_LABEL,
  AUTH_METHOD_LABEL,
  CONN_ADDRESS_STEPS,
  CONN_CAUSE_HINTS,
  CONN_CAUSE_TITLE,
  CONN_DROP_TEXT,
  CONN_ERROR_CODE_TEXT,
  CONN_PROMPT_TEXT,
  CONN_SERVER_TEXT_STEPS,
  CONN_STEP_TEXT,
  CONN_TUNNEL_TEXT,
} from '@shared/conn-text';
import { formatDateTime, formatDuration } from './format';
import { t } from './i18n';
import { api, useApp } from './store';

/** English sentences that may arrive as a step's `reason` and have translations. */
const KNOWN_REASONS = new Set([...Object.values(CONN_DROP_TEXT), ...Object.values(CONN_TUNNEL_TEXT)]);

function methodLabel(m: string): string {
  return AUTH_METHOD_LABEL[m] ? t(AUTH_METHOD_LABEL[m]) : m;
}

/** Translates the parts of params that are words rather than data (method names, codes…). */
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
  if (typeof out.reason === 'string' && KNOWN_REASONS.has(out.reason)) out.reason = t(out.reason);
  if (typeof out.code === 'string' && CONN_ERROR_CODE_TEXT[out.code]) out.code = `${t(CONN_ERROR_CODE_TEXT[out.code])} · ${out.code}`;
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

export function stepText(step: ConnStep, attempt?: ConnAttempt, params: ConnParams | undefined = step.params): string {
  const p = localize(params);
  if (step.code === 'prompt') {
    const what = String(step.params?.what ?? '');
    return t(CONN_PROMPT_TEXT[what] ?? CONN_STEP_TEXT.prompt, p);
  }
  if (step.code === 'failed' && attempt?.cause) return causeTitle(attempt.cause, attempt.causeParams);
  return t(CONN_STEP_TEXT[step.code] ?? step.code, p);
}

export function stepShowsAddress(step: ConnStep): boolean {
  return CONN_ADDRESS_STEPS.has(step.code);
}

/** Which host-editor tab can fix a given cause; undefined when editing the host would not help. */
export function editorTabFor(cause: ConnCause | undefined): 'general' | 'auth' | 'advanced' | undefined {
  switch (cause) {
    case undefined:
    case 'hostkey-rejected':
    case 'cancelled':
    case 'interrupted':
    case 'login-timeout':
    case 'vault-locked':
      return undefined;
    case 'algorithms':
    case 'algorithms-unsupported':
    case 'dropped':
    case 'jump':
    case 'jump-forward':
    case 'jump-missing':
      return 'advanced';
  }
  if (cause.startsWith('auth-') || cause.startsWith('agent-') || cause.startsWith('key-')) return 'auth';
  return 'general';
}

/** Causes that are not a problem with the host (the user stopped, or Gatehouse quit). */
export function isBenignCause(cause: ConnCause | undefined): boolean {
  return cause === 'cancelled' || cause === 'interrupted';
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
  useApp.getState().toast({
    kind: 'error',
    title,
    message: why,
    action: attemptId ? { label: t('View details'), run: () => useApp.getState().openConnLog(hostId, attemptId) } : undefined,
  });
}

/** Like attempt(), for operations on a host: connection failures get the diagnosis. */
export async function hostAttempt<T>(hostId: string, fn: () => Promise<T>, errorTitle: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    await hostErrorToast(hostId, errorTitle, err);
    return undefined;
  }
}

// ---------------------------------------------------------------- copied report

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
// Hex-and-colon runs; the replacer keeps clock times like 08:30:12.
const IPV6_CANDIDATE = /(?<![0-9A-Za-z:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:%[\w.]+)?(?![0-9A-Za-z:])/g;

/** Masks the given names (whole words, any case) and every IP address in data text. */
export function maskAddresses(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...new Set(secrets.filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegex(s)}(?![A-Za-z0-9_-])`, 'gi'), '[…]');
  }
  out = out.replace(IPV4, '[…]');
  out = out.replace(IPV6_CANDIDATE, (m) => ((m.match(/:/g) ?? []).length >= 3 || m.includes('::') ? '[…]' : m));
  return out;
}

/** ssh2 log lines that quote text the server chose (a disconnect reason, its greeting, debug messages). */
const SERVER_TEXT_LINE = /^(Debug output from server|Inbound: Received DISCONNECT|Remote ident|Inbound: Received USERAUTH_BANNER)/;

/** Plain-text report of one attempt, in the current language, for the clipboard. */
export function buildReport(a: ConnAttempt, opts: { includeAddresses: boolean; appVersion: string; platform: string }): string {
  const hide = !opts.includeAddresses;
  const secrets: string[] = [];
  if (hide) {
    secrets.push(a.target.hostname);
    if (a.target.username) secrets.push(a.target.username);
    for (const s of a.steps) {
      for (const k of ['addresses', 'address', 'name', 'user'] as const) {
        const v = s.params?.[k];
        if (typeof v === 'string') secrets.push(...v.split(',').map((x) => x.replace('…', '').trim()));
      }
    }
  }
  const data = (s: string) => (hide ? maskAddresses(s, secrets) : s);
  const target = `${a.target.username ? `${a.target.username}@` : ''}${a.target.hostname}:${a.target.port}`;
  const lines: string[] = [];
  lines.push(t('Gatehouse connection report'));
  lines.push(`${t('Host')}: ${data(a.hostLabel)} (${a.hostAlias})`);
  lines.push(`${t('Address')}: ${hide ? t('(hidden)') : target}${a.via ? ` · ${t('Through jump host {jump}', { jump: a.via })}` : ''}`);
  lines.push(`${t('Time')}: ${formatDateTime(a.startedAt)}${a.durationMs !== undefined ? ` · ${formatDuration(a.durationMs)}` : ''} · ${a.initiatedBy === 'ai' ? t('Started by Claude') : t('Started by you')}`);
  lines.push(`${t('Result')}: ${attemptHeadline(a)}`);
  if (a.server) lines.push(`${t('Server software')}: ${data(a.server)}`);
  if (a.outcome === 'failed' || a.endCause === 'dropped') {
    lines.push('', `${t('What you can do')}:`);
    for (const h of causeHints(a.outcome === 'failed' ? a.cause : 'dropped', a.causeParams)) lines.push(`- ${h}`);
  }
  lines.push('', `${t('Connection steps')}:`);
  for (const s of a.steps) {
    const mark = s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : '·';
    // Text the server chose can name anything; leave it out when hiding addresses.
    const quotesServer = CONN_SERVER_TEXT_STEPS.has(s.code) && (s.code !== 'prompt' || s.params?.what === 'keyboard-interactive');
    const params = hide && quotesServer ? Object.fromEntries(Object.entries(s.params ?? {}).map(([k, v]) => [k, k === 'what' ? v : t('(hidden)')])) : s.params;
    lines.push(`+${formatDuration(s.at).padEnd(7)} ${mark} ${data(stepText(s, a, params))}`);
  }
  if (a.error) lines.push('', `${t('Error')}: ${data(a.error)}`);
  if (a.log?.length) {
    lines.push('', `${t('Technical log')}:`);
    for (const l of a.log) {
      if (hide && SERVER_TEXT_LINE.test(l)) lines.push(t('(server text hidden)'));
      else lines.push(data(l));
    }
  }
  lines.push('', `Gatehouse ${opts.appVersion} · ${opts.platform}`);
  return lines.join('\n');
}

export { formatDuration };
