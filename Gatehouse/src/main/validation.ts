// Validation for everything that crosses the renderer → main boundary.

import { z } from 'zod';
import type { Settings } from '../shared/types';
import { ALIAS_PATTERN } from '../shared/defaults';
import { WSL_DISTRO_PATTERN } from '../shared/shells';

export const hostnameSchema = z
  .string()
  .trim()
  .min(1, 'Hostname is required')
  .max(253)
  .regex(/^(?!-)[A-Za-z0-9._:%[\]-]+$/, 'Hostname contains invalid characters');

export const usernameSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^(?!-)[A-Za-z0-9._@\\$-]*$/, 'Username contains invalid characters');

const colorSchema = z.enum(['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']);

const patternList = z.array(z.string().max(500)).max(200);

export const aiPolicySchema = z.object({
  mode: z.enum(['off', 'read-only', 'ask', 'trusted']),
  fileWrite: z.enum(['deny', 'ask', 'allow']),
  allowPatterns: patternList,
  denyPatterns: patternList,
  requireTouchId: z.boolean(),
  description: z.string().max(500),
});

export const shellSettingsSchema = z.object({
  platform: z.enum(['auto', 'posix', 'windows']),
  windowsDefault: z.enum(['powershell', 'wsl']),
  powershell: z.enum(['desktop', 'core']),
  wsl: z.boolean(),
  wslDistro: z.string().trim().max(64).refine((v) => v === '' || WSL_DISTRO_PATTERN.test(v), 'WSL distribution: letters, digits, dots, dashes and underscores'),
});

export const hostInputSchema = z.object({
  id: z.string().uuid().optional(),
  alias: z.string().trim().toLowerCase().regex(ALIAS_PATTERN, 'Alias: lowercase letters, digits and dashes (max 40)'),
  name: z.string().trim().max(80),
  hostname: hostnameSchema,
  port: z.number().int().min(1).max(65535),
  username: usernameSchema,
  auth: z.enum(['key', 'password', 'agent', 'interactive']),
  keyId: z.string().uuid().optional().nullable(),
  savePassword: z.boolean(),
  jumpHostId: z.string().uuid().optional().nullable(),
  group: z.string().trim().max(60),
  tags: z.array(z.string().trim().min(1).max(30)).max(20),
  color: colorSchema,
  notes: z.string().max(5000),
  keepAliveSec: z.number().int().min(0).max(600),
  startupCommand: z.string().max(1000),
  favorite: z.boolean(),
  legacyAlgorithms: z.boolean(),
  ai: aiPolicySchema,
  shell: shellSettingsSchema,
});
export type HostInput = z.infer<typeof hostInputSchema>;

export const forwardInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().max(80),
  hostId: z.string().uuid(),
  type: z.enum(['local', 'remote', 'dynamic']),
  bindAddress: z.string().trim().regex(/^[A-Za-z0-9.:[\]-]+$/).max(64),
  bindPort: z.number().int().min(1).max(65535),
  destHost: z.string().trim().max(253).regex(/^[A-Za-z0-9._:[\]-]*$/),
  destPort: z.number().int().min(0).max(65535),
  autoStart: z.boolean(),
});

export const snippetInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  command: z.string().min(1).max(8000),
  description: z.string().max(500),
  tags: z.array(z.string().trim().min(1).max(30)).max(20),
  aiAllowed: z.boolean(),
});

export const keyGenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['ed25519', 'rsa', 'ecdsa']),
  bits: z.number().int().optional(),
  comment: z.string().max(200),
  passphrase: z.string().max(1024).optional(),
  savePassphrase: z.boolean(),
});

export const keyImportSchema = z.object({
  name: z.string().trim().min(1).max(80),
  privateKey: z.string().min(1).max(64 * 1024),
  passphrase: z.string().max(1024).optional(),
  savePassphrase: z.boolean(),
});

export const approvalDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('allow'),
    scope: z.enum(['once', 'always', 'grant']),
    editedCommand: z.string().max(16 * 1024).optional(),
    confirmText: z.string().max(100).optional(),
  }),
  z.object({ action: z.literal('deny'), message: z.string().max(2000).optional() }),
]);

export const pathSchema = z.string().min(1).max(4096).refine((p) => !p.includes('\0'), 'Invalid path');

const clamp = (v: number, min: number, max: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v * 100) / 100)) : fallback;

/** Keeps numeric settings within sane bounds after a merge. */
export function clampSettings(s: Settings): Settings {
  s.terminal.fontSize = clamp(s.terminal.fontSize, 9, 32, 13);
  s.terminal.lineHeight = clamp(s.terminal.lineHeight, 1, 2, 1.25);
  s.terminal.scrollback = clamp(s.terminal.scrollback, 500, 200000, 10000);
  s.security.autoLockMinutes = clamp(s.security.autoLockMinutes, 0, 720, 0);
  s.ai.approvalTimeoutSec = clamp(s.ai.approvalTimeoutSec, 15, 900, 120);
  s.ai.rateLimitPerMinute = clamp(s.ai.rateLimitPerMinute, 1, 600, 30);
  s.ai.dailyQuota = clamp(s.ai.dailyQuota, 1, 100000, 500);
  s.ai.maxOutputKB = clamp(s.ai.maxOutputKB, 4, 512, 48);
  s.ai.commandTimeoutSec = clamp(s.ai.commandTimeoutSec, 5, 3600, 60);
  s.ai.grantMinutes = clamp(s.ai.grantMinutes, 1, 240, 15);
  s.ai.auditRetentionDays = clamp(s.ai.auditRetentionDays, 1, 3650, 90);
  const list = (a: unknown, max = 200) =>
    (Array.isArray(a) ? a : []).filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 500)).slice(0, max);
  s.ai.extraReadOnlyCommands = list(s.ai.extraReadOnlyCommands);
  s.ai.dangerPatterns = list(s.ai.dangerPatterns);
  s.ai.blockPatterns = list(s.ai.blockPatterns);
  s.ai.sensitivePaths = list(s.ai.sensitivePaths, 500);
  s.ai.redaction.customRules = (Array.isArray(s.ai.redaction.customRules) ? s.ai.redaction.customRules : [])
    .filter((r) => r && typeof r.pattern === 'string')
    .slice(0, 100)
    .map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? '').slice(0, 80),
      pattern: String(r.pattern).slice(0, 500),
      flags: String(r.flags ?? '').replace(/[^gimsuy]/g, ''),
      replacement: String(r.replacement ?? '').slice(0, 200),
      enabled: !!r.enabled,
    }));
  if (!['system', 'en', 'zh-Hans'].includes(s.language)) s.language = 'system';
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
  return s;
}
