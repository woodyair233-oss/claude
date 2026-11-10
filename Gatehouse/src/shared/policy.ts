// Turns a host policy + command assessment into allow / ask / deny.

import type { AiSettings, CommandAssessment, DecidedBy, Host, PolicyCause, SecuritySettings } from './types';
import {
  DEFAULT_SENSITIVE_PATHS,
  commandParts,
  describeReason,
  isSensitivePath,
  isSystemPath,
  matchCommandPattern,
} from './command-policy';
import { DEFAULT_WINDOWS_SENSITIVE_PATHS, isWindowsSensitivePath, isWindowsSystemPath } from './powershell-policy';
import { effectivePlatform } from './shells';

/** Sensitive-path test that also knows Windows locations on Windows hosts. */
function pathIsSensitive(host: Host, ai: AiSettings, path: string): boolean {
  if (effectivePlatform(host) === 'windows') {
    const extra = ai.sensitivePaths.length ? ai.sensitivePaths : DEFAULT_WINDOWS_SENSITIVE_PATHS;
    return isWindowsSensitivePath(path, extra) || isSensitivePath(path, sensitivePatterns(ai));
  }
  return isSensitivePath(path, sensitivePatterns(ai));
}

function pathIsSystem(host: Host, path: string): boolean {
  return effectivePlatform(host) === 'windows' ? isWindowsSystemPath(path) || isSystemPath(path) : isSystemPath(path);
}

export type DenyCode = 'blocked' | 'read-only' | 'host-deny' | 'file-write-disabled' | 'ai-off';

export type Decision =
  | { verdict: 'allow'; by: DecidedBy }
  | { verdict: 'ask'; cause: PolicyCause; requireTouchId: boolean; allowRemember: boolean }
  | { verdict: 'deny'; code: DenyCode; message: string };

const allow = (by: DecidedBy): Decision => ({ verdict: 'allow', by });
const deny = (code: DenyCode, message: string): Decision => ({ verdict: 'deny', code, message });

function sensitivePatterns(ai: AiSettings): string[] {
  return ai.sensitivePaths.length ? ai.sensitivePaths : DEFAULT_SENSITIVE_PATHS;
}

export interface CommandDecisionInput {
  host: Host;
  ai: AiSettings;
  security: SecuritySettings;
  command: string;
  assessment: CommandAssessment;
  grantActive: boolean;
}

export function decideCommand({ host, ai, security, command, assessment: a, grantActive }: CommandDecisionInput): Decision {
  const mode = host.ai.mode;
  if (mode === 'off') return deny('ai-off', `Host "${host.alias}" is not available to AI.`);

  if (a.risk === 'block') {
    const why = a.reasons.filter((r) => r.code === 'root-delete' || r.code === 'fork-bomb' || r.code === 'device-overwrite' || r.code === 'custom-block' || r.code === 'empty');
    return deny('blocked', `Gatehouse always blocks this command: it ${why.map(describeReason).join('; ') || 'is not allowed'}.`);
  }

  const parts = commandParts(command);
  const denied = host.ai.denyPatterns.find((p) => parts.some((part) => matchCommandPattern(part, p)));
  if (denied) return deny('host-deny', `The user has blocked commands matching "${denied}" on "${host.alias}".`);

  const touch = host.ai.requireTouchId || (a.risk === 'danger' && security.touchIdForDangerous);
  const ask = (cause: PolicyCause): Decision => ({
    verdict: 'ask',
    cause,
    requireTouchId: touch,
    allowRemember: a.risk !== 'danger' && a.simple && !a.sensitive,
  });

  // Order matters: danger, credential-file and read-only checks all run before
  // the per-host allowlist, so a broad "always allow" pattern cannot be used to
  // slip a dangerous or secret-touching command past them.
  if (a.risk === 'danger') {
    if (mode === 'read-only') {
      return deny('read-only', `"${host.alias}" is read-only for AI and this command ${a.reasons.filter((r) => r.code !== 'sensitive-path').map(describeReason).slice(0, 3).join('; ')}.`);
    }
    return ask('danger');
  }
  if (a.sensitive) return ask(mode === 'read-only' ? 'read-only-sensitive' : 'sensitive');
  if (mode === 'read-only') {
    if (a.risk === 'read') return allow('policy');
    return deny(
      'read-only',
      `"${host.alias}" is read-only for AI and this command ${a.reasons.map(describeReason).slice(0, 3).join('; ')}.`,
    );
  }

  if (a.simple && host.ai.allowPatterns.some((p) => matchCommandPattern(command, p))) {
    return allow('allowlist');
  }

  if (grantActive) return allow('grant');

  switch (mode) {
    case 'ask':
      return a.risk === 'read' && ai.autoApproveReadOnly ? allow('policy') : ask('mode-ask');
    case 'trusted':
      return allow('policy');
  }
}

export function decideFileRead(host: Host, ai: AiSettings, path: string): Decision {
  if (host.ai.mode === 'off') return deny('ai-off', `Host "${host.alias}" is not available to AI.`);
  if (pathIsSensitive(host, ai, path)) {
    return {
      verdict: 'ask',
      cause: host.ai.mode === 'read-only' ? 'read-only-sensitive' : 'sensitive',
      requireTouchId: host.ai.requireTouchId,
      allowRemember: false,
    };
  }
  return allow('policy');
}

export function decideListDirectory(host: Host): Decision {
  if (host.ai.mode === 'off') return deny('ai-off', `Host "${host.alias}" is not available to AI.`);
  return allow('policy');
}

export function decideFileWrite(
  host: Host,
  ai: AiSettings,
  security: SecuritySettings,
  path: string,
  grantActive: boolean,
): Decision {
  const mode = host.ai.mode;
  if (mode === 'off') return deny('ai-off', `Host "${host.alias}" is not available to AI.`);
  if (mode === 'read-only') return deny('read-only', `"${host.alias}" is read-only for AI; writing files is not allowed.`);
  if (host.ai.fileWrite === 'deny') return deny('file-write-disabled', `File writes are disabled for AI on "${host.alias}".`);
  const touch = host.ai.requireTouchId;
  if (pathIsSensitive(host, ai, path)) {
    return { verdict: 'ask', cause: 'sensitive', requireTouchId: touch, allowRemember: false };
  }
  if (pathIsSystem(host, path) || /authorized_keys|sshd_config/.test(path)) {
    return { verdict: 'ask', cause: 'system-path', requireTouchId: touch || security.touchIdForDangerous, allowRemember: false };
  }
  if (host.ai.fileWrite === 'allow') return allow('policy');
  if (grantActive) return allow('grant');
  return { verdict: 'ask', cause: 'file-write', requireTouchId: touch, allowRemember: false };
}

export function decideSnippet(host: Host, assessment: CommandAssessment): Decision {
  if (host.ai.mode === 'off') return deny('ai-off', `Host "${host.alias}" is not available to AI.`);
  if (assessment.risk === 'block') return deny('blocked', 'This snippet contains a command Gatehouse always blocks.');
  if (host.ai.mode === 'read-only' && assessment.risk !== 'read') {
    return deny('read-only', `"${host.alias}" is read-only for AI and this snippet modifies the system.`);
  }
  if (assessment.risk === 'danger') {
    return { verdict: 'ask', cause: 'danger', requireTouchId: host.ai.requireTouchId, allowRemember: false };
  }
  return allow('snippet');
}
