import { describe, expect, it } from 'vitest';
import { assessCommand } from '../../src/shared/command-policy';
import { decideCommand } from '../../src/shared/policy';
import { defaultSettings, newHost } from '../../src/shared/defaults';
import type { AiMode } from '../../src/shared/types';

const settings = defaultSettings();

function decide(command: string, mode: AiMode, opts: { allow?: string[]; grant?: boolean } = {}) {
  const host = newHost({ id: 'h1', alias: 'lab' }, mode);
  if (opts.allow) host.ai.allowPatterns = opts.allow;
  return decideCommand({
    host,
    ai: settings.ai,
    security: settings.security,
    command,
    assessment: assessCommand(command),
    grantActive: opts.grant ?? false,
  });
}

describe('policy ordering (review #5)', () => {
  it('allowlist cannot bypass the credential-file check', () => {
    // A broad allow pattern must not auto-approve a command that also reads secrets.
    const d = decide('cat /etc/shadow x.log', 'ask', { allow: ['/^cat .*$/'] });
    expect(d.verdict).toBe('ask');
    if (d.verdict === 'ask') expect(d.cause).toBe('sensitive');
  });
  it('allowlist cannot bypass read-only mode', () => {
    const d = decide('systemctl restart nginx', 'read-only', { allow: ['systemctl restart nginx'] });
    expect(d.verdict).toBe('deny');
  });
  it('allowlist cannot bypass danger classification', () => {
    const d = decide('rm -rf /tmp/build', 'trusted', { allow: ['/^rm .*$/'] });
    expect(d.verdict).toBe('ask');
    if (d.verdict === 'ask') expect(d.cause).toBe('danger');
  });
  it('still honours an exact allowlist entry for a benign write', () => {
    const d = decide('touch /tmp/marker', 'ask', { allow: ['touch /tmp/marker'] });
    expect(d.verdict).toBe('allow');
  });
  it('read-only host still auto-approves reads', () => {
    expect(decide('ls -la /var/log', 'read-only').verdict).toBe('allow');
  });
});
