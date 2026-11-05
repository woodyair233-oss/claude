// xterm.js instances live outside React so they survive view switches.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { TerminalSettings } from '@shared/types';
import { terminalTheme } from './themes';

interface Entry {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  webgl?: WebglAddon;
  opened: boolean;
}

const entries = new Map<string, Entry>();
const early = new Map<string, Uint8Array[]>();
let current: TerminalSettings | null = null;
let pasteGuard: ((text: string) => Promise<boolean>) | null = null;
let listening = false;

const api = () => window.gatehouse;

export function setPasteGuard(fn: (text: string) => Promise<boolean>) {
  pasteGuard = fn;
}

export function startTerminalDataPump() {
  if (listening) return;
  listening = true;
  api().on.terminalData((id, data) => {
    const e = entries.get(id);
    if (!e) {
      const list = early.get(id) ?? [];
      list.push(data);
      early.set(id, list);
      return;
    }
    e.term.write(data, () => api().terminal.ack(id, data.byteLength));
  });
}

function options(s: TerminalSettings) {
  return {
    fontFamily: `"${s.fontFamily}", "JetBrains Mono", "SF Mono", Menlo, Monaco, monospace`,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    macOptionIsMeta: s.optionIsMeta,
    theme: terminalTheme(s.theme).theme,
  } as const;
}


export function ensureTerminal(id: string, settings: TerminalSettings): Entry {
  current = settings;
  const existing = entries.get(id);
  if (existing) return existing;
  const el = document.createElement('div');
  el.className = 'xterm-host';
  const term = new Terminal({
    ...options(settings),
    allowProposedApi: true,
    convertEol: false,
    drawBoldTextInBrightColors: true,
    rightClickSelectsWord: true,
    smoothScrollDuration: 0,
    linkHandler: {
      activate: (_e, uri) => {
        if (/^https?:\/\//i.test(uri)) void api().app.openExternal(uri);
      },
      allowNonHttpProtocols: false,
    },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => {
    if (/^https?:\/\//i.test(uri)) void api().app.openExternal(uri);
  }));
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';

  term.onData((d) => api().terminal.write(id, d));
  term.onResize(({ cols, rows }) => api().terminal.resize(id, cols, rows));
  term.onSelectionChange(() => {
    if (current?.copyOnSelect && term.hasSelection()) void api().app.clipboardWrite(term.getSelection());
  });
  term.onBell(() => {
    if (current?.bell) el.animate([{ filter: 'brightness(1.6)' }, { filter: 'none' }], { duration: 180 });
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey && e.shiftKey;
    if (!mod) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) {
      void api().app.clipboardWrite(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (k === 'v') {
      // Let the browser's paste event fire; the capture-phase listener below
      // runs the multi-line guard and performs the paste exactly once.
      return true;
    }
    if (k === 'a') {
      term.selectAll();
      return false;
    }
    // Let the app handle the remaining shortcuts (tabs, palette, search…).
    return false;
  });

  // Intercept every paste (keyboard, Edit menu, right-click) before xterm's own
  // textarea handler, so the multi-line guard runs and the text is never pasted
  // twice. preventDefault stops the native paste from also reaching the pty.
  el.addEventListener(
    'paste',
    (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text) return;
      if (text.includes('\n') && pasteGuard) {
        void pasteGuard(text).then((ok) => {
          if (ok) term.paste(text);
        });
      } else {
        term.paste(text);
      }
    },
    true,
  );

  const entry: Entry = { term, fit, search, el, opened: false };
  entries.set(id, entry);
  return entry;
}

export function attachTerminal(id: string, container: HTMLElement) {
  const e = entries.get(id);
  if (!e) return;
  if (e.el.parentElement !== container) container.appendChild(e.el);
  if (!e.opened) {
    e.term.open(e.el);
    e.opened = true;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        e.webgl = undefined;
      });
      e.term.loadAddon(webgl);
      e.webgl = webgl;
    } catch {
      /* DOM renderer fallback */
    }
    const buffered = early.get(id);
    if (buffered) {
      early.delete(id);
      for (const chunk of buffered) e.term.write(chunk, () => api().terminal.ack(id, chunk.byteLength));
    }
  }
  fitTerminal(id);
}

export function fitTerminal(id: string) {
  const e = entries.get(id);
  if (!e || !e.opened || !e.el.isConnected || e.el.clientWidth === 0) return;
  try {
    e.fit.fit();
  } catch {
    /* not visible yet */
  }
}

export function focusTerminal(id: string) {
  entries.get(id)?.term.focus();
}

export function terminalSize(id: string): { cols: number; rows: number } {
  const e = entries.get(id);
  return e ? { cols: e.term.cols, rows: e.term.rows } : { cols: 100, rows: 30 };
}

export function searchTerminal(id: string, query: string, direction: 'next' | 'prev' = 'next') {
  const e = entries.get(id);
  if (!e || !query) return false;
  const opts = { caseSensitive: false, decorations: { matchOverviewRuler: '#ffcc00', activeMatchColorOverviewRuler: '#ff9f0a', matchBackground: '#ffcc0055', activeMatchBackground: '#ff9f0a99' } };
  return direction === 'next' ? e.search.findNext(query, opts) : e.search.findPrevious(query, opts);
}

export function clearSearch(id: string) {
  entries.get(id)?.search.clearDecorations();
}

export function clearTerminal(id: string) {
  entries.get(id)?.term.clear();
}

export function getSelection(id: string): string {
  return entries.get(id)?.term.getSelection() ?? '';
}

export function pasteInto(id: string, text: string) {
  entries.get(id)?.term.paste(text);
}

export function disposeTerminal(id: string) {
  const e = entries.get(id);
  if (!e) return;
  e.term.dispose();
  e.el.remove();
  entries.delete(id);
  early.delete(id);
}

export function applyTerminalSettings(settings: TerminalSettings) {
  current = settings;
  const opts = options(settings);
  for (const [id, e] of entries) {
    Object.assign(e.term.options, opts);
    fitTerminal(id);
  }
}
