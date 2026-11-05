import { describe, expect, it } from 'vitest';
import { TokenMap, detokenize, redact, sanitizeOutput, truncateMiddle } from '../../src/shared/redaction';
import { defaultSettings } from '../../src/shared/defaults';

const settings = () => structuredClone(defaultSettings().ai.redaction);

function run(text: string, opts: Partial<Parameters<typeof redact>[1]> = {}) {
  const tokens = opts.tokens ?? new TokenMap();
  return {
    tokens,
    ...redact(text, {
      settings: opts.settings ?? settings(),
      identities: opts.identities ?? [],
      tokens,
    }),
  };
}

describe('sanitizeOutput', () => {
  it('strips ANSI colours and OSC sequences', () => {
    expect(sanitizeOutput('\u001b[31mred\u001b[0m \u001b]0;title\u0007ok')).toBe('red ok');
  });
  it('makes bidi overrides and zero-width characters visible', () => {
    expect(sanitizeOutput('safe‮evil')).toBe('safe[U+202E]evil');
    expect(sanitizeOutput('a​b')).toBe('a[U+200B]b');
  });
  it('normalises carriage returns and drops other controls visibly', () => {
    expect(sanitizeOutput('a\r\nb\rc\u0001')).toBe('a\nb\nc[^01]');
  });
});

describe('truncateMiddle', () => {
  it('keeps head and tail', () => {
    const big = 'A'.repeat(5000) + 'TAIL';
    const r = truncateMiddle(big, 1000);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith('TAIL')).toBe(true);
    expect(r.text).toContain('bytes omitted');
  });
  it('leaves small output alone', () => {
    expect(truncateMiddle('hi', 100)).toEqual({ text: 'hi', truncated: false, omitted: 0 });
  });
});

describe('redact', () => {
  it('replaces IPv4 addresses with stable tokens', () => {
    const r = run('from 10.0.0.5 to 192.168.1.20, again 10.0.0.5');
    expect(r.text).toBe('from [ip-1] to [ip-2], again [ip-1]');
    expect(r.kinds.ip).toBe(3);
  });
  it('keeps loopback, netmasks and version strings', () => {
    const r = run('127.0.0.1 0.0.0.0 255.255.255.0 v1.2.3.4 1.2.3.4.5 node-18.1.2.3a');
    expect(r.text).toBe('127.0.0.1 0.0.0.0 255.255.255.0 v1.2.3.4 1.2.3.4.5 node-18.1.2.3a');
  });
  it('redacts IPv6 but not ::1 or clock times', () => {
    const r = run('inet6 fe80::1c2b:3cff:fe4d:5e6f/64 and 2001:db8::1 and ::1 at 12:34:56');
    expect(r.text).toBe('inet6 [ipv6-1]/64 and [ipv6-2] and ::1 at 12:34:56');
  });
  it('redacts MAC addresses', () => {
    expect(run('link/ether 02:42:ac:11:00:02 brd ff:ff:ff:ff:ff:ff').text).toBe('link/ether [mac-1] brd ff:ff:ff:ff:ff:ff');
  });
  it('replaces saved host identities with alias tokens', () => {
    const r = run('Welcome alice to db.internal.example.com (db.internal.example.com)', {
      identities: [{ alias: 'prod-db', hostname: 'db.internal.example.com', username: 'alice', visible: true }],
    });
    expect(r.text).toBe('Welcome [user:prod-db] to [host:prod-db] ([host:prod-db])');
    expect(r.tokens.resolve('[host:prod-db]')).toBe('db.internal.example.com');
  });
  it('uses opaque tokens for hosts hidden from AI', () => {
    const r = run('ping secret.example.org', {
      identities: [{ alias: 'hidden', hostname: 'secret.example.org', username: 'root', visible: false }],
    });
    expect(r.text).toBe('ping [host-1]');
  });
  it('does not redact common usernames', () => {
    const r = run('user root logged in', {
      identities: [{ alias: 'a', hostname: '10.1.1.1', username: 'root', visible: true }],
    });
    expect(r.text).toBe('user root logged in');
  });
  it('redacts private keys and token formats', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const r = run(`${key}\nAKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ sk-ant-api03-abcdefghijklmnopqrstuv`);
    expect(r.text).toBe('[redacted private key]\n[redacted] [redacted] [redacted]');
  });
  it('redacts key=value secrets and URL credentials', () => {
    const r = run('DB_PASSWORD=hunter22 api_key: "abcd1234" url=postgres://app:s3cret@[ip-9]/db PasswordAuthentication no');
    expect(r.text).toContain('DB_PASSWORD=[redacted]');
    expect(r.text).toContain('api_key: "[redacted]"');
    expect(r.text).toContain('postgres://[redacted]');
    expect(r.text).toContain('PasswordAuthentication no');
  });
  it('redacts high-entropy strings but not hashes or paths', () => {
    const r = run('token Zx9fK2LmQ8rT4vW7yB1nC5dE3gH6jP0sAq and sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 /usr/local/lib/python3.12/site-packages');
    expect(r.text).toContain('token [redacted]');
    expect(r.text).toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(r.text).toContain('/usr/local/lib/python3.12/site-packages');
  });
  it('applies custom rules with capture groups', () => {
    const s = settings();
    s.customRules = [{ id: '1', name: 'MRN', pattern: 'MRN(\\d{2})\\d+', flags: '', replacement: 'MRN$1****', enabled: true }];
    expect(run('patient MRN12345678', { settings: s }).text).toBe('patient MRN12****');
  });
  it('respects disabled categories', () => {
    const s = settings();
    s.ipAddresses = false;
    expect(run('10.0.0.1', { settings: s }).text).toBe('10.0.0.1');
  });
});

describe('detokenize', () => {
  it('restores known tokens and reports unknown ones', () => {
    const tokens = new TokenMap();
    const t = tokens.token('ip', '10.0.0.5');
    tokens.define('[host:web]', 'web.example.com');
    const r = detokenize(`curl http://${t}:8080 && ssh [host:web] && ping [ip-99]`, tokens);
    expect(r.text).toBe('curl http://10.0.0.5:8080 && ssh web.example.com && ping [ip-99]');
    expect(r.replaced).toEqual(['[ip-1]', '[host:web]']);
    expect(r.unknown).toEqual(['[ip-99]']);
  });
});
