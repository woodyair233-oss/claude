import type { LanguagePref } from '@shared/types';
import { ZH } from './zh';

export type Lang = 'en' | 'zh-Hans';
let lang: Lang = 'en';

export function resolveLang(pref: LanguagePref): Lang {
  if (pref === 'en' || pref === 'zh-Hans') return pref;
  return (navigator.languages ?? [navigator.language]).some((l) => l.toLowerCase().startsWith('zh')) ? 'zh-Hans' : 'en';
}

export function setLang(pref: LanguagePref): Lang {
  lang = resolveLang(pref);
  document.documentElement.lang = lang === 'zh-Hans' ? 'zh-CN' : 'en';
  return lang;
}

export function currentLang(): Lang {
  return lang;
}

/** English text is the key; Chinese comes from the ZH table (falls back to English). */
export function t(s: string, params?: Record<string, string | number>): string {
  let out = lang === 'zh-Hans' ? (ZH[s] ?? s) : s;
  if (params) out = out.replace(/\{(\w+)\}/g, (_m, k: string) => (k in params ? String(params[k]) : `{${k}}`));
  return out;
}
