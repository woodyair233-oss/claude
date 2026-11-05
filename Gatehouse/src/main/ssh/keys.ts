import { createHash, randomUUID } from 'node:crypto';
import ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2';
import type { KeyType, SshKeyInfo } from '../../shared/types';

const { utils } = ssh2;

export function fingerprintBlob(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** Reads the algorithm name (first SSH string) from a public key blob. */
export function blobKeyType(blob: Buffer): string {
  if (blob.length < 4) return 'unknown';
  const len = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + len).toString('ascii');
}

function readSshString(buf: Buffer, offset: number): [Buffer, number] {
  const len = buf.readUInt32BE(offset);
  return [buf.subarray(offset + 4, offset + 4 + len), offset + 4 + len];
}

export function describeBlob(blob: Buffer): { type: KeyType; bits?: number } {
  const algo = blobKeyType(blob);
  if (algo === 'ssh-ed25519') return { type: 'ed25519', bits: 256 };
  if (algo === 'ssh-rsa') {
    try {
      let off = 0;
      [, off] = readSshString(blob, off); // algo
      [, off] = readSshString(blob, off); // e
      const [n] = readSshString(blob, off);
      let bytes = n.length;
      if (n[0] === 0) bytes -= 1;
      return { type: 'rsa', bits: bytes * 8 };
    } catch {
      return { type: 'rsa' };
    }
  }
  if (algo.startsWith('ecdsa-sha2-nistp')) return { type: 'ecdsa', bits: Number(algo.slice('ecdsa-sha2-nistp'.length)) || undefined };
  return { type: 'unknown' };
}

function firstKey(parsed: ParsedKey | ParsedKey[] | Error): ParsedKey | Error {
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

export class KeyError extends Error {
  constructor(
    message: string,
    readonly code: 'needs-passphrase' | 'bad-passphrase' | 'invalid' | 'public-only',
  ) {
    super(message);
  }
}

/** Parses a private key, throwing KeyError with a precise code on failure. */
export function parsePrivateKey(pem: string, passphrase?: string): ParsedKey {
  const parsed = firstKey(utils.parseKey(pem, passphrase || undefined) as ParsedKey | ParsedKey[] | Error);
  if (parsed instanceof Error) {
    const msg = parsed.message.toLowerCase();
    if (msg.includes('no passphrase') || msg.includes('passphrase required') || msg.includes('encrypted')) {
      if (passphrase) throw new KeyError('The passphrase is incorrect.', 'bad-passphrase');
      throw new KeyError('This key is protected by a passphrase.', 'needs-passphrase');
    }
    if (msg.includes('bad passphrase') || msg.includes('decrypt') || msg.includes('integrity')) {
      throw new KeyError('The passphrase is incorrect.', 'bad-passphrase');
    }
    throw new KeyError(`Not a supported private key: ${parsed.message}`, 'invalid');
  }
  if (!parsed.isPrivateKey()) throw new KeyError('This is a public key. Import the private key file instead.', 'public-only');
  return parsed;
}

export function isEncryptedKey(pem: string): boolean {
  try {
    parsePrivateKey(pem);
    return false;
  } catch (err) {
    return err instanceof KeyError && err.code === 'needs-passphrase';
  }
}

function openSshPublicLine(key: ParsedKey, comment: string): string {
  const blob = key.getPublicSSH();
  return `${blobKeyType(blob)} ${blob.toString('base64')}${comment ? ' ' + comment : ''}`;
}

export interface KeyMaterial {
  info: SshKeyInfo;
  privateKey: string;
}

export function keyInfoFromPrivate(
  pem: string,
  opts: { name: string; passphrase?: string; savePassphrase: boolean; source: 'generated' | 'imported'; id?: string },
): KeyMaterial {
  const key = parsePrivateKey(pem, opts.passphrase);
  const blob = key.getPublicSSH();
  const { type, bits } = describeBlob(blob);
  const comment = key.comment || '';
  return {
    privateKey: pem,
    info: {
      id: opts.id ?? randomUUID(),
      name: opts.name,
      type,
      bits,
      publicKey: openSshPublicLine(key, comment),
      fingerprint: fingerprintBlob(blob),
      comment,
      encrypted: !!opts.passphrase,
      savePassphrase: !!opts.passphrase && opts.savePassphrase,
      source: opts.source,
      createdAt: Date.now(),
    },
  };
}

export function generateKey(opts: {
  name: string;
  type: 'ed25519' | 'rsa' | 'ecdsa';
  bits?: number;
  comment: string;
  passphrase?: string;
  savePassphrase: boolean;
}): KeyMaterial {
  const common = {
    comment: opts.comment,
    ...(opts.passphrase ? { passphrase: opts.passphrase, cipher: 'aes256-ctr' } : {}),
  };
  let pair: { private: string; public: string };
  if (opts.type === 'rsa') {
    const bits = opts.bits && [3072, 4096].includes(opts.bits) ? opts.bits : 4096;
    pair = utils.generateKeyPairSync('rsa', { bits, ...common });
  } else if (opts.type === 'ecdsa') {
    const bits = opts.bits && [256, 384, 521].includes(opts.bits) ? opts.bits : 256;
    pair = utils.generateKeyPairSync('ecdsa', { bits: bits as 256 | 384 | 521, ...common });
  } else {
    pair = utils.generateKeyPairSync('ed25519', common);
  }
  return keyInfoFromPrivate(pair.private, {
    name: opts.name,
    passphrase: opts.passphrase,
    savePassphrase: opts.savePassphrase,
    source: 'generated',
  });
}
