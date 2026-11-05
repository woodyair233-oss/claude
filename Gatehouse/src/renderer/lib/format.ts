import { currentLang, t } from './i18n';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function relativeTime(ts: number | undefined): string {
  if (!ts) return t('never');
  const diff = Date.now() - ts;
  const rtf = new Intl.RelativeTimeFormat(currentLang() === 'zh-Hans' ? 'zh-CN' : 'en', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 45_000) return t('just now');
  if (abs < 3_600_000) return rtf.format(-Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(-Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(-Math.round(diff / 86_400_000), 'day');
  return formatDate(ts);
}

export function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(currentLang() === 'zh-Hans' ? 'zh-CN' : 'en', { dateStyle: 'medium' }).format(ts);
}

export function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(currentLang() === 'zh-Hans' ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ts);
}

export function formatDateTime(ts: number): string {
  return new Intl.DateTimeFormat(currentLang() === 'zh-Hans' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(ts);
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function plural(n: number, one: string, many: string): string {
  return t(n === 1 ? one : many, { n });
}
