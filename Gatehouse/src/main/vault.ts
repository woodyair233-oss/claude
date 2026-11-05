// Encrypted secret storage.
//
// Secrets (host passwords, private keys, key passphrases) are sealed with a
// random 256-bit data key (AES-256-GCM). The data key itself is wrapped by
// the macOS Keychain (Electron safeStorage) and/or a master password
// (scrypt). Either wrap can unlock the vault, so the master password doubles
// as a recovery path when the Keychain entry is lost or a re-signed build is
// refused access.

import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from 'node:crypto';
import { safeStorage } from 'electron';
import { readJsonSync, writeFileAtomic } from './fsutil';

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

interface PasswordWrap extends Sealed {
  salt: string;
  N: number;
  r: number;
  p: number;
}

interface VaultFile {
  version: 1;
  keychain?: string;
  password?: PasswordWrap;
  secrets?: Sealed;
}

export interface Secrets {
  hostPasswords: Record<string, string>;
  keyPrivate: Record<string, string>;
  keyPassphrases: Record<string, string>;
}

export type VaultState = 'uninitialized' | 'locked' | 'unlocked';
export type VaultBackend = 'keychain' | 'os' | 'basic' | 'unavailable';

export interface VaultStatus {
  state: VaultState;
  backend: VaultBackend;
  keychainWrap: boolean;
  passwordWrap: boolean;
}

const emptySecrets = (): Secrets => ({ hostPasswords: {}, keyPrivate: {}, keyPassphrases: {} });

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, 32, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function seal(plain: Buffer, key: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(sealed: Sealed, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
}

const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 };

export async function derivePasswordKey(password: string, salt: Buffer, params = SCRYPT_PARAMS): Promise<Buffer> {
  return scrypt(password, salt, { ...params, maxmem: 256 * 1024 * 1024 });
}

export { seal as sealWithKey, open as openWithKey };

export class Vault extends EventEmitter {
  private dek: Buffer | null = null;
  private secrets: Secrets = emptySecrets();
  private file: VaultFile = { version: 1 };
  private state: VaultState = 'uninitialized';
  backend: VaultBackend = 'unavailable';

  constructor(private readonly path: string) {
    super();
  }

  status(): VaultStatus {
    return {
      state: this.state,
      backend: this.backend,
      keychainWrap: !!this.file.keychain,
      passwordWrap: !!this.file.password,
    };
  }

  get unlocked(): boolean {
    return this.state === 'unlocked';
  }

  private async detectBackend(): Promise<VaultBackend> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        // Linux without a keyring (CI, containers): fall back to Chromium's obfuscation, flagged as 'basic' in the UI.
        if (process.platform !== 'linux') return 'unavailable';
        safeStorage.setUsePlainTextEncryption(true);
        if (!(await safeStorage.isAsyncEncryptionAvailable())) return 'unavailable';
      }
      // Electron #55433: availability can be reported on builds that then fail to encrypt.
      const probe = `gatehouse-probe-${randomBytes(6).toString('hex')}`;
      const enc = await safeStorage.encryptStringAsync(probe);
      const dec = await safeStorage.decryptStringAsync(enc);
      if (dec.result !== probe) return 'unavailable';
      if (process.platform === 'darwin') return 'keychain';
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return 'basic';
      return 'os';
    } catch (err) {
      console.warn('[gatehouse] safeStorage unavailable:', (err as Error).message);
      return 'unavailable';
    }
  }

  async init(): Promise<VaultState> {
    this.file = readJsonSync<VaultFile>(this.path) ?? { version: 1 };
    this.backend = await this.detectBackend();
    if (!this.file.keychain && !this.file.password) {
      if (this.backend !== 'unavailable') {
        await this.create();
      } else {
        this.state = 'uninitialized';
      }
      return this.state;
    }
    if (this.file.keychain && this.backend !== 'unavailable') {
      try {
        const { result } = await safeStorage.decryptStringAsync(Buffer.from(this.file.keychain, 'base64'));
        this.adopt(Buffer.from(result, 'hex'));
        return this.state;
      } catch (err) {
        console.warn('[gatehouse] keychain unwrap failed:', (err as Error).message);
      }
    }
    this.state = 'locked';
    return this.state;
  }

  private adopt(dek: Buffer) {
    if (dek.length !== 32) throw new Error('Invalid vault key');
    this.secrets = this.file.secrets ? (JSON.parse(open(this.file.secrets, dek).toString('utf8')) as Secrets) : emptySecrets();
    this.secrets = { ...emptySecrets(), ...this.secrets };
    this.dek = dek;
    this.state = 'unlocked';
    this.emit('change');
  }

  /** Creates a fresh vault. With no Keychain available a master password is mandatory. */
  async create(password?: string): Promise<void> {
    if (this.backend === 'unavailable' && !password) throw new Error('A master password is required on this system.');
    this.dek = randomBytes(32);
    this.secrets = emptySecrets();
    this.file = { version: 1 };
    if (this.backend !== 'unavailable') {
      this.file.keychain = (await safeStorage.encryptStringAsync(this.dek.toString('hex'))).toString('base64');
    }
    if (password) this.file.password = await this.wrapWithPassword(this.dek, password);
    this.state = 'unlocked';
    await this.persist();
    this.emit('change');
  }

  async unlockWithPassword(password: string): Promise<boolean> {
    const wrap = this.file.password;
    if (!wrap) return false;
    try {
      const kek = await derivePasswordKey(password, Buffer.from(wrap.salt, 'base64'), { N: wrap.N, r: wrap.r, p: wrap.p });
      this.adopt(open(wrap, kek));
      // Re-wrap with the Keychain if it became available again (e.g. after re-signing).
      if (!this.file.keychain && this.backend !== 'unavailable' && this.dek) {
        this.file.keychain = (await safeStorage.encryptStringAsync(this.dek.toString('hex'))).toString('base64');
        await this.persist();
      }
      return true;
    } catch {
      return false;
    }
  }

  async verifyPassword(password: string): Promise<boolean> {
    const wrap = this.file.password;
    if (!wrap) return false;
    try {
      const kek = await derivePasswordKey(password, Buffer.from(wrap.salt, 'base64'), { N: wrap.N, r: wrap.r, p: wrap.p });
      open(wrap, kek);
      return true;
    } catch {
      return false;
    }
  }

  private async wrapWithPassword(dek: Buffer, password: string): Promise<PasswordWrap> {
    const salt = randomBytes(16);
    const kek = await derivePasswordKey(password, salt);
    return { ...seal(dek, kek), salt: salt.toString('base64'), ...SCRYPT_PARAMS };
  }

  /** Adds, changes (pass a new password) or removes (null) the master password. */
  async setPassword(password: string | null): Promise<void> {
    if (!this.dek) throw new Error('Vault is locked');
    if (password === null) {
      if (!this.file.keychain) throw new Error('Cannot remove the master password while the Keychain is not in use.');
      delete this.file.password;
    } else {
      if (password.length < 8) throw new Error('Use at least 8 characters.');
      this.file.password = await this.wrapWithPassword(this.dek, password);
    }
    await this.persist();
    this.emit('change');
  }

  async setKeychainEnabled(enabled: boolean): Promise<void> {
    if (!this.dek) throw new Error('Vault is locked');
    if (enabled) {
      if (this.backend === 'unavailable') throw new Error('The system keychain is not available.');
      this.file.keychain = (await safeStorage.encryptStringAsync(this.dek.toString('hex'))).toString('base64');
    } else {
      if (!this.file.password) throw new Error('Set a master password before turning off the Keychain.');
      delete this.file.keychain;
    }
    await this.persist();
    this.emit('change');
  }

  private async persist() {
    if (this.dek) this.file.secrets = seal(Buffer.from(JSON.stringify(this.secrets), 'utf8'), this.dek);
    await writeFileAtomic(this.path, JSON.stringify(this.file, null, 2));
  }

  private requireUnlocked() {
    if (!this.dek) throw new Error('Gatehouse is locked. Unlock it to use saved credentials.');
  }

  private async mutate(fn: (s: Secrets) => void) {
    this.requireUnlocked();
    fn(this.secrets);
    await this.persist();
    this.emit('change');
  }

  getHostPassword(hostId: string): string | undefined {
    this.requireUnlocked();
    return this.secrets.hostPasswords[hostId];
  }

  async setHostPassword(hostId: string, password: string | null) {
    await this.mutate((s) => {
      if (password === null) delete s.hostPasswords[hostId];
      else s.hostPasswords[hostId] = password;
    });
  }

  getPrivateKey(keyId: string): string | undefined {
    this.requireUnlocked();
    return this.secrets.keyPrivate[keyId];
  }

  async setPrivateKey(keyId: string, pem: string | null) {
    await this.mutate((s) => {
      if (pem === null) {
        delete s.keyPrivate[keyId];
        delete s.keyPassphrases[keyId];
      } else s.keyPrivate[keyId] = pem;
    });
  }

  getKeyPassphrase(keyId: string): string | undefined {
    this.requireUnlocked();
    return this.secrets.keyPassphrases[keyId];
  }

  async setKeyPassphrase(keyId: string, passphrase: string | null) {
    await this.mutate((s) => {
      if (passphrase === null) delete s.keyPassphrases[keyId];
      else s.keyPassphrases[keyId] = passphrase;
    });
  }

  savedPasswordHostIds(): string[] {
    return this.dek ? Object.keys(this.secrets.hostPasswords) : [];
  }

  /** For encrypted backups. */
  exportSecrets(): Secrets {
    this.requireUnlocked();
    return structuredClone(this.secrets);
  }

  async importSecrets(secrets: Secrets) {
    await this.mutate((s) => {
      Object.assign(s.hostPasswords, secrets.hostPasswords ?? {});
      Object.assign(s.keyPrivate, secrets.keyPrivate ?? {});
      Object.assign(s.keyPassphrases, secrets.keyPassphrases ?? {});
    });
  }

  async forgetHost(hostId: string) {
    if (!this.dek || !(hostId in this.secrets.hostPasswords)) return;
    await this.setHostPassword(hostId, null);
  }
}
