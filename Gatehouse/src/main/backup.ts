// Password-encrypted export / import of all data including secrets.

import { randomBytes } from 'node:crypto';
import { derivePasswordKey, openWithKey, sealWithKey, type Secrets } from './vault';
import type { StoreData } from './store';

interface BackupFile {
  format: 'gatehouse-backup';
  version: 1;
  createdAt: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export interface BackupPayload {
  store: StoreData;
  secrets: Secrets | null;
}

export async function encryptBackup(payload: BackupPayload, password: string): Promise<string> {
  if (password.length < 8) throw new Error('Use a backup password of at least 8 characters.');
  const salt = randomBytes(16);
  const key = await derivePasswordKey(password, salt);
  const sealed = sealWithKey(Buffer.from(JSON.stringify(payload), 'utf8'), key);
  const file: BackupFile = {
    format: 'gatehouse-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    ...sealed,
  };
  return JSON.stringify(file, null, 2);
}

export async function decryptBackup(text: string, password: string): Promise<BackupPayload> {
  let file: BackupFile;
  try {
    file = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('This is not a Gatehouse backup file.');
  }
  if (file.format !== 'gatehouse-backup' || file.version !== 1) throw new Error('Unsupported backup format.');
  const key = await derivePasswordKey(password, Buffer.from(file.salt, 'base64'));
  try {
    return JSON.parse(openWithKey(file, key).toString('utf8')) as BackupPayload;
  } catch {
    throw new Error('Wrong password, or the backup is damaged.');
  }
}
