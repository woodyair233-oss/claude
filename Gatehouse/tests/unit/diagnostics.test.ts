// Connection diagnostics: the classifier, the log store and the copied report.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnAttempt, ConnCause, Host } from '../../src/shared/types';
import { newHost } from '../../src/shared/defaults';
import { CONN_CAUSE_HINTS, CONN_CAUSE_TITLE, connCauseMessage } from '../../src/shared/conn-text';
import { cleanServerText, ConnLog, ConnPrepError, diagnose, dropReason, keyTypeLabel, type DiagnoseFacts } from '../../src/main/ssh/diagnostics';
import { buildReport } from '../../src/renderer/lib/conn';

const base: DiagnoseFacts = { stage: 'auth', port: 22 };
const cause = (f: Partial<DiagnoseFacts>): ConnCause => diagnose({ ...base, ...f }).cause;

describe('diagnose()', () => {
  it('reports problems found before connecting', () => {
    expect(cause({ stage: 'prepare', prepCause: 'vault-locked' })).toBe('vault-locked');
    expect(cause({ stage: 'prepare', error: { message: 'Connection was cancelled.' } })).toBe('cancelled');
  });

  it('separates name, network and port problems', () => {
    expect(cause({ stage: 'dns', error: { code: 'ENOTFOUND' } })).toBe('dns');
    expect(cause({ stage: 'dns', error: { code: 'EDNSTIMEOUT' } })).toBe('dns');
    expect(diagnose({ ...base, stage: 'tcp', error: { code: 'ECONNREFUSED' } })).toEqual({ cause: 'refused', params: { port: 22 } });
    expect(cause({ stage: 'tcp', error: { code: 'ETIMEDOUT' } })).toBe('tcp-timeout');
    expect(cause({ stage: 'tcp', error: { code: 'EHOSTUNREACH' } })).toBe('unreachable');
    expect(cause({ stage: 'tcp', error: { code: 'ENETUNREACH' } })).toBe('unreachable');
    expect(cause({ stage: 'tcp', error: { code: 'ECONNRESET' } })).toBe('reset');
    expect(cause({ stage: 'tcp', error: { code: 'EWEIRD' } })).toBe('unknown');
  });

  it('separates a failing jump host from one that cannot reach the target', () => {
    expect(diagnose({ ...base, stage: 'jump', via: 'bastion' })).toEqual({ cause: 'jump', params: { jump: 'bastion' } });
    expect(cause({ stage: 'jump', via: 'bastion', tunnelFailed: true })).toBe('jump-forward');
  });

  it('uses the second look at a port that never spoke SSH', () => {
    expect(cause({ stage: 'ident', probe: { kind: 'text', banner: 'HTTP/1.1 400 Bad Request' } })).toBe('not-ssh');
    expect(cause({ stage: 'ident', probe: { kind: 'silent' } })).toBe('no-greeting');
    expect(cause({ stage: 'ident', probe: { kind: 'closed' } })).toBe('reset');
    expect(cause({ stage: 'ident', probe: { kind: 'ssh', software: 'OpenSSH_9.6' } })).toBe('reset');
    expect(cause({ stage: 'ident', identTimedOut: true })).toBe('no-greeting');
    expect(cause({ stage: 'ident', error: { message: 'Connection lost before handshake' } })).toBe('reset');
  });

  it('explains algorithm mismatches, and whether legacy algorithms would help', () => {
    const msg = { message: 'Handshake failed: no matching key exchange algorithm', level: 'handshake' };
    expect(diagnose({ ...base, stage: 'kex', error: msg, remoteAlgos: { kex: 'diffie-hellman-group1-sha1,diffie-hellman-group14-sha1' } })).toEqual({
      cause: 'algorithms',
      params: { what: 'kex', offered: 'diffie-hellman-group1-sha1,diffie-hellman-group14-sha1' },
    });
    expect(cause({ stage: 'kex', error: msg, remoteAlgos: { kex: 'sntrup761x25519-sha512@openssh.com' } })).toBe('algorithms-unsupported');
    expect(cause({ stage: 'kex', error: msg, legacyEnabled: true, remoteAlgos: { kex: 'diffie-hellman-group1-sha1' } })).toBe('algorithms-unsupported');
    expect(diagnose({ ...base, stage: 'kex', error: { message: 'Handshake failed: no matching host key format' } }).params?.what).toBe('hostKey');
    expect(diagnose({ ...base, stage: 'kex', error: { message: 'Handshake failed: no matching C->S cipher' } }).params?.what).toBe('cipher');
  });

  it('recognises a rejected server identity and abandoned prompts', () => {
    expect(cause({ stage: 'kex', hostKeyRejected: true, error: { message: 'Host denied (verification failed)' } })).toBe('hostkey-rejected');
    expect(cause({ stage: 'kex', error: { message: 'Host denied (verification failed)' } })).toBe('hostkey-rejected');
    expect(cause({ stage: 'auth', promptCancelled: true })).toBe('cancelled');
    expect(cause({ stage: 'auth', promptPending: true, error: { message: 'Timed out while waiting for handshake', level: 'client-timeout' } })).toBe('cancelled');
    expect(cause({ stage: 'kex', error: { message: 'Timed out while waiting for handshake', level: 'client-timeout' } })).toBe('handshake-timeout');
  });

  it('names the login problem precisely', () => {
    const refused = { message: 'All configured authentication methods failed', level: 'client-authentication' };
    expect(cause({ error: refused, firstMethod: 'password', lastMethod: 'password', allowed: ['publickey', 'password'] })).toBe('auth-password');
    expect(diagnose({ ...base, error: refused, firstMethod: 'password', lastMethod: 'password', allowed: ['publickey'] })).toEqual({
      cause: 'auth-method',
      params: { method: 'password', allowed: 'publickey' },
    });
    expect(cause({ error: refused, firstMethod: 'publickey', lastMethod: 'publickey', allowed: ['publickey', 'password'] })).toBe('auth-key');
    expect(cause({ error: refused, firstMethod: 'agent', lastMethod: 'agent', allowed: ['publickey'] })).toBe('auth-agent');
    expect(cause({ error: refused, firstMethod: 'agent', lastMethod: 'agent' })).toBe('auth-agent');
    expect(cause({ error: refused, firstMethod: 'keyboard-interactive', lastMethod: 'keyboard-interactive', allowed: ['keyboard-interactive'] })).toBe('auth-interactive');
    // A password sent through the keyboard-interactive fallback is still a wrong password.
    expect(cause({ error: refused, firstMethod: 'password', lastMethod: 'keyboard-interactive', allowed: ['publickey', 'keyboard-interactive'] })).toBe('auth-password');
    // Two-step login: the first step passed, nothing was available for the second.
    expect(diagnose({ ...base, error: refused, firstMethod: 'publickey', lastMethod: 'publickey', partial: true, allowed: ['keyboard-interactive'] })).toEqual({
      cause: 'auth-partial',
      params: { allowed: 'keyboard-interactive' },
    });
    // …or the second step was tried and refused (a wrong code).
    expect(cause({ error: refused, firstMethod: 'publickey', lastMethod: 'keyboard-interactive', partial: true, triedAfterPartial: true, allowed: ['keyboard-interactive'] })).toBe(
      'auth-interactive',
    );
  });

  it('falls back sensibly', () => {
    expect(cause({ stage: 'kex', error: { code: 'ECONNRESET', message: 'read ECONNRESET' } })).toBe('reset');
    expect(cause({ stage: 'kex', error: { message: 'something odd' } })).toBe('unknown');
  });
});

describe('connection text', () => {
  it('has a title and hints for every cause, and summaries never carry addresses', () => {
    for (const c of Object.keys(CONN_CAUSE_TITLE) as ConnCause[]) {
      expect(CONN_CAUSE_TITLE[c]).toBeTruthy();
      expect(CONN_CAUSE_HINTS[c]).toBeTruthy();
      // Title placeholders are limited to values Claude may see.
      for (const p of CONN_CAUSE_TITLE[c].match(/\{\w+\}/g) ?? []) expect(['{port}', '{method}', '{jump}']).toContain(p);
    }
    expect(connCauseMessage('refused', { port: 2222 })).toBe('The server refused the connection on port 2222');
  });

  it('cleans text sent by a server', () => {
    expect(cleanServerText('Hello\u001b[31m\r\nWorld‮!')).toBe('Hello [31m World !');
    expect(cleanServerText('x'.repeat(500), 20)).toHaveLength(20);
  });

  it('describes why a live connection ended', () => {
    expect(dropReason(undefined)).toMatch(/closed the connection/);
    expect(dropReason(new Error('Keepalive timeout'))).toMatch(/keep-alive/);
    expect(dropReason(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toMatch(/reset/);
    expect(dropReason(Object.assign(new Error('x'), { code: 'ENETUNREACH' }))).toMatch(/unreachable/);
    expect(dropReason(new Error('weird'))).toMatch(/unexpected/);
  });

  it('names key types readably', () => {
    expect(keyTypeLabel('ssh-ed25519')).toBe('ED25519');
    expect(keyTypeLabel('ecdsa-sha2-nistp256')).toBe('ECDSA P-256');
    expect(keyTypeLabel('rsa-sha2-512')).toBe('RSA');
  });
});

function host(i: number): Host {
  return newHost({ id: `h${i}`, alias: `host-${i}`, name: `Host ${i}`, hostname: `10.0.0.${i}`, port: 22, username: 'admin' });
}

describe('ConnLog', () => {
  it('records attempts, newest first, and leaves the protocol log out of lists', () => {
    const log = new ConnLog();
    const tr = log.begin(host(1), 'user');
    tr.debug('Remote ident: \'SSH-2.0-OpenSSH_9.6\'');
    tr.failed(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 22);
    const [first] = log.list();
    expect(first.outcome).toBe('failed');
    expect(first.log).toBeUndefined();
    expect(first.logLines).toBe(1);
    expect(log.get(first.id)?.log).toHaveLength(1);
    expect(log.get(first.id)?.server).toBe('OpenSSH_9.6');
  });

  it('turns a prepare-time failure into its cause', () => {
    const log = new ConnLog();
    const err = log.begin(host(1), 'ai').failed(new ConnPrepError('No SSH agent found.', 'agent-missing'), 22);
    expect(err.connCause).toBe('agent-missing');
    expect(err.message).toBe('No SSH agent is running');
    expect(log.latest('h1')).toMatchObject({ cause: 'agent-missing', initiatedBy: 'ai', error: 'No SSH agent found.' });
  });

  it('keeps a bounded history per host and overall, and logs only for recent failures', () => {
    const log = new ConnLog();
    for (let i = 0; i < 40; i++) log.begin(host(1), 'user').failed(new Error('x'), 22);
    expect(log.list('h1')).toHaveLength(30);
    for (let h = 2; h < 12; h++) for (let i = 0; i < 25; i++) log.begin(host(h), 'user').failed(new Error('x'), 22);
    expect(log.list()).toHaveLength(200);
    const withLog = log.list().filter((a) => a.logLines !== 0);
    expect(withLog.length).toBeLessThanOrEqual(25);
  });

  it('never drops an attempt that is still running', () => {
    const log = new ConnLog();
    const running = log.begin(host(1), 'user');
    for (let i = 0; i < 40; i++) log.begin(host(1), 'user').failed(new Error('x'), 22);
    expect(log.get(running.attempt.id)?.outcome).toBe('connecting');
  });

  it('reports the latest status per host, including drops', () => {
    const log = new ConnLog();
    const a = log.begin(host(1), 'user');
    a.connected();
    expect(log.statuses().h1).toMatchObject({ outcome: 'connected', attemptId: a.attempt.id });
    a.ended('dropped', 'The network stopped responding.');
    expect(log.statuses().h1).toMatchObject({ dropped: true });
    log.begin(host(1), 'user').failed(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 22);
    expect(log.statuses().h1).toMatchObject({ outcome: 'failed' });
  });

  it('clears one host or everything, but not running attempts', () => {
    const log = new ConnLog();
    log.begin(host(1), 'user').failed(new Error('x'), 22);
    log.begin(host(2), 'user').failed(new Error('x'), 22);
    const running = log.begin(host(1), 'user');
    log.clear('h1');
    expect(log.list('h1').map((a) => a.id)).toEqual([running.attempt.id]);
    expect(log.list('h2')).toHaveLength(1);
    log.clear();
    expect(log.list().map((a) => a.id)).toEqual([running.attempt.id]);
  });

  it('persists privately and recovers attempts interrupted by a quit', () => {
    const dir = mkdtempSync('/tmp/gh-connlog-');
    const path = join(dir, 'connections.json');
    const log = new ConnLog(path);
    log.begin(host(1), 'user').failed(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 22);
    const open = log.begin(host(2), 'user');
    open.connected();
    log.begin(host(3), 'user'); // still connecting when we "quit"
    log.flushSync();
    expect(statSync(path).mode & 0o077).toBe(0);
    const again = new ConnLog(path);
    expect(again.latest('h3')).toMatchObject({ outcome: 'failed', cause: 'cancelled' });
    expect(again.latest('h2')).toMatchObject({ outcome: 'connected', endCause: 'closed' });
    expect(again.latest('h1')?.cause).toBe('refused');
  });

  it('ignores a damaged file', () => {
    const dir = mkdtempSync('/tmp/gh-connlog-');
    const path = join(dir, 'connections.json');
    writeFileSync(path, JSON.stringify({ version: 1, attempts: [{ id: 1 }, null, 'x'] }));
    expect(new ConnLog(path).list()).toEqual([]);
    writeFileSync(path, '{not json');
    expect(new ConnLog(path).list()).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });
});

describe('copied report', () => {
  const attempt: ConnAttempt = {
    id: 'a1',
    hostId: 'h1',
    hostLabel: 'Ward server',
    hostAlias: 'ward',
    target: { hostname: 'db.ward.example.org', port: 2222, username: 'zhang' },
    initiatedBy: 'user',
    startedAt: Date.UTC(2026, 10, 8, 8, 0, 0),
    durationMs: 640,
    outcome: 'failed',
    cause: 'auth-password',
    message: 'The username or password was not accepted',
    server: 'OpenSSH_9.6',
    steps: [
      { at: 3, code: 'dns-ok', status: 'ok', params: { name: 'db.ward.example.org', addresses: '10.20.30.40, fd00::7', ms: 3 } },
      { at: 9, code: 'tcp-ok', status: 'ok', params: { address: '10.20.30.40', port: 2222, ms: 6 } },
      { at: 60, code: 'auth-try', status: 'info', params: { user: 'zhang', method: 'password' } },
      { at: 640, code: 'auth-fail', status: 'fail', params: { method: 'password', allowed: 'publickey, password' } },
      { at: 640, code: 'failed', status: 'fail' },
    ],
    log: ['Socket connected to 10.20.30.40', 'Inbound: Received USERAUTH_FAILURE (publickey,password)'],
  };

  it('hides the address and username unless asked', () => {
    const hidden = buildReport(attempt, { includeAddresses: false, appVersion: '1.0.0', platform: 'darwin' });
    for (const secret of ['db.ward.example.org', '10.20.30.40', 'fd00::7', 'zhang']) expect(hidden).not.toContain(secret);
    expect(hidden).toContain('ward');
    expect(hidden).toContain('The username or password was not accepted');
    expect(hidden).toContain('Rejected: Password. The server accepts: SSH key, Password');
    // Advice text is not mangled by the masking.
    expect(hidden).toContain('Many servers do not let “root” log in with a password.');

    const shown = buildReport(attempt, { includeAddresses: true, appVersion: '1.0.0', platform: 'darwin' });
    expect(shown).toContain('zhang@db.ward.example.org:2222');
    expect(shown).toContain('10.20.30.40');
  });
});
