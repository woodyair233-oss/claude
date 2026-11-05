import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { mkdir, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function ensureDirSync(dir: string, mode = 0o700) {
  mkdirSync(dir, { recursive: true, mode });
  try {
    chmodSync(dir, mode);
  } catch {
    /* best effort */
  }
}

export function readJsonSync<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write-then-rename so a crash never leaves a half-written file. Files are private to the user. */
export function writeFileAtomicSync(path: string, data: string | Buffer, mode = 0o600) {
  ensureDirSync(dirname(path));
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export async function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode).catch(() => undefined);
  await rename(tmp, path);
}

/** Serialises async writes to the same file and coalesces bursts. */
export class DebouncedWriter {
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly serialize: () => string,
    private readonly delayMs = 150,
  ) {}

  schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const data = this.serialize();
    this.writing = this.writing.then(() => writeFileAtomic(this.path, data)).catch((err) => {
      console.error('[gatehouse] write failed', this.path, err);
    });
    return this.writing;
  }

  flushSync() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    writeFileAtomicSync(this.path, this.serialize());
  }
}
