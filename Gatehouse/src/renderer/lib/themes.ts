import type { ITheme } from '@xterm/xterm';
import type { AccentColor, HostColor } from '@shared/types';

export const ACCENTS: Record<AccentColor, { light: string; dark: string; hoverLight: string; hoverDark: string }> = {
  blue: { light: '#0a7cff', dark: '#2f8fff', hoverLight: '#0068e0', hoverDark: '#4a9fff' },
  indigo: { light: '#5856d6', dark: '#6e6cf0', hoverLight: '#4846c2', hoverDark: '#8280f5' },
  violet: { light: '#8b5cf6', dark: '#9d7bf8', hoverLight: '#7746ea', hoverDark: '#b096fa' },
  pink: { light: '#e83e8c', dark: '#f0609f', hoverLight: '#d22b78', hoverDark: '#f47cb0' },
  orange: { light: '#f07800', dark: '#ff9426', hoverLight: '#d96c00', hoverDark: '#ffa64d' },
  green: { light: '#22a04b', dark: '#34c25f', hoverLight: '#1b8b40', hoverDark: '#4fd175' },
  teal: { light: '#0f9fb0', dark: '#22c3d4', hoverLight: '#0b8a99', hoverDark: '#44d0de' },
  graphite: { light: '#6b6b73', dark: '#9a9aa3', hoverLight: '#58585f', hoverDark: '#acacb4' },
};

export function isDark(): boolean {
  return document.documentElement.dataset.theme === 'dark';
}

export function applyAccent(accent: AccentColor) {
  const dark = isDark();
  const a = ACCENTS[accent] ?? ACCENTS.blue;
  const root = document.documentElement.style;
  root.setProperty('--accent', dark ? a.dark : a.light);
  root.setProperty('--accent-hover', dark ? a.hoverDark : a.hoverLight);
}

export const HOST_COLOR_HEX: Record<HostColor, string> = {
  gray: '#8e8e93',
  red: '#ff453a',
  orange: '#ff9f0a',
  yellow: '#ffcc00',
  green: '#30d158',
  teal: '#40c8e0',
  blue: '#0a84ff',
  indigo: '#5e5ce6',
  purple: '#bf5af2',
  pink: '#ff375f',
};

export interface TerminalThemeDef {
  id: string;
  name: string;
  dark: boolean;
  theme: ITheme;
}

const base = {
  black: '#1b1d23',
  red: '#ff6b6b',
  green: '#5ad48a',
  yellow: '#ffd166',
  blue: '#5aa9ff',
  magenta: '#c49bff',
  cyan: '#4fd6e0',
  white: '#d8dbe2',
  brightBlack: '#5c6370',
  brightRed: '#ff8787',
  brightGreen: '#7ee2a3',
  brightYellow: '#ffdd8a',
  brightBlue: '#82bfff',
  brightMagenta: '#d7b8ff',
  brightCyan: '#7ee4ec',
  brightWhite: '#ffffff',
};

export const TERMINAL_THEMES: TerminalThemeDef[] = [
  {
    id: 'gatehouse-dark',
    name: 'Gatehouse Dark',
    dark: true,
    theme: { ...base, background: '#141519', foreground: '#e3e5ea', cursor: '#7cb4ff', cursorAccent: '#141519', selectionBackground: '#3b5b8c99' },
  },
  {
    id: 'gatehouse-light',
    name: 'Gatehouse Light',
    dark: false,
    theme: {
      background: '#ffffff',
      foreground: '#2b2d33',
      cursor: '#0a7cff',
      cursorAccent: '#ffffff',
      selectionBackground: '#0a7cff33',
      black: '#2b2d33',
      red: '#d63a3a',
      green: '#18864b',
      yellow: '#a86e00',
      blue: '#0b62d6',
      magenta: '#8a3fd1',
      cyan: '#0a8494',
      white: '#bfc3cc',
      brightBlack: '#6e7380',
      brightRed: '#e85454',
      brightGreen: '#22a35d',
      brightYellow: '#c28a00',
      brightBlue: '#2f7deb',
      brightMagenta: '#a25ee6',
      brightCyan: '#0fa1b3',
      brightWhite: '#2b2d33',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    dark: true,
    theme: { ...base, background: '#0b1020', foreground: '#cdd6f4', cursor: '#89b4fa', cursorAccent: '#0b1020', selectionBackground: '#45587a88', blue: '#89b4fa', magenta: '#cba6f7', cyan: '#89dceb', green: '#a6e3a1', yellow: '#f9e2af', red: '#f38ba8' },
  },
  {
    id: 'forest',
    name: 'Forest',
    dark: true,
    theme: { ...base, background: '#0f1712', foreground: '#d5e3d7', cursor: '#7fd69a', cursorAccent: '#0f1712', selectionBackground: '#3c5a4688', green: '#7fd69a', cyan: '#6fcfc2', blue: '#78b6e3' },
  },
  {
    id: 'dusk',
    name: 'Dusk',
    dark: true,
    theme: { ...base, background: '#1a1423', foreground: '#e6dcf2', cursor: '#d29bff', cursorAccent: '#1a1423', selectionBackground: '#5b416f88', magenta: '#e0a3ff', blue: '#9db2ff', red: '#ff7aa2' },
  },
  {
    id: 'paper',
    name: 'Paper',
    dark: false,
    theme: {
      background: '#faf7f0',
      foreground: '#3b3a36',
      cursor: '#b5651d',
      cursorAccent: '#faf7f0',
      selectionBackground: '#e8d9b8aa',
      black: '#3b3a36',
      red: '#b5402e',
      green: '#4f7a28',
      yellow: '#9a6a00',
      blue: '#2f5d9b',
      magenta: '#8a4b8f',
      cyan: '#2a7d7d',
      white: '#c9c3b6',
      brightBlack: '#7a766c',
      brightRed: '#cc5440',
      brightGreen: '#629538',
      brightYellow: '#b58200',
      brightBlue: '#4174b5',
      brightMagenta: '#a15fa6',
      brightCyan: '#379595',
      brightWhite: '#3b3a36',
    },
  },
  {
    id: 'contrast',
    name: 'High Contrast',
    dark: true,
    theme: { ...base, background: '#000000', foreground: '#ffffff', cursor: '#ffff00', cursorAccent: '#000000', selectionBackground: '#ffffff55', white: '#ffffff', brightBlack: '#a0a0a0' },
  },
];

export function terminalTheme(id: string): TerminalThemeDef {
  if (id === 'auto' || !TERMINAL_THEMES.some((t) => t.id === id)) {
    const dark = isDark();
    return TERMINAL_THEMES.find((t) => t.id === (dark ? 'gatehouse-dark' : 'gatehouse-light'))!;
  }
  return TERMINAL_THEMES.find((t) => t.id === id)!;
}
