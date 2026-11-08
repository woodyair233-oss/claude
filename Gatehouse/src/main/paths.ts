import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Honour GATEHOUSE_HOME (tests, portable setups). Must run before app 'ready'. */
export function configureUserData() {
  const override = process.env.GATEHOUSE_HOME;
  if (override) app.setPath('userData', resolve(override));
}

export const dataDir = () => app.getPath('userData');
export const runDir = () => join(dataDir(), 'run');
export const auditDir = () => join(dataDir(), 'audit');
export const storePath = () => join(dataDir(), 'gatehouse.json');
export const vaultPath = () => join(dataDir(), 'vault.json');
export const connLogPath = () => join(dataDir(), 'connections.json');
export const endpointPath = () => join(runDir(), 'endpoint.json');

/** Unix socket path; falls back to /tmp when the data dir path is too long for sun_path (104 bytes on macOS). */
export function socketPath(): string {
  const preferred = join(runDir(), 'mcp.sock');
  if (Buffer.byteLength(preferred) < 100) return preferred;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join('/tmp', `gatehouse-${uid}`, 'mcp.sock');
}

export function bridgePath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'bin', 'gatehouse-mcp');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return resolve(app.getAppPath(), 'build', 'bin', `${process.platform}-${arch}`, 'gatehouse-mcp');
}

export function resourcePath(...parts: string[]): string {
  if (app.isPackaged) return join(process.resourcesPath, ...parts);
  return resolve(app.getAppPath(), 'build', ...parts);
}

export function rendererDir(): string {
  return resolve(app.getAppPath(), 'dist', 'renderer');
}

export function fileExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
