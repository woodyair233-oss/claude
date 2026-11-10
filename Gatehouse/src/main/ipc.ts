import { app, clipboard, dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ContextMenuItem, Host, HostDraft, PortForward, PromptResponse, Snippet } from '../shared/types';
import { newForward, newHost, newSnippet, slugify } from '../shared/defaults';
import { describeReason } from '../shared/command-policy';
import { assessShellCommand, chooseShell } from '../shared/shells';
import { decideCommand } from '../shared/policy';
import { TokenMap, redact, sanitizeOutput } from '../shared/redaction';
import type { AppContext } from './context';
import { buildSnapshot } from './context';
import {
  approvalDecisionSchema,
  clampSettings,
  forwardInputSchema,
  hostInputSchema,
  keyGenSchema,
  keyImportSchema,
  pathSchema,
  snippetInputSchema,
} from './validation';
import { generateKey, keyInfoFromPrivate, KeyError } from './ssh/keys';
import { parseSshConfig } from './ssh/ssh-config';
import { execCommand, shellQuote } from './ssh/exec';
import { isConnectError } from './ssh/diagnostics';
import { installClaudeCode, installClaudeDesktop, selfTest, setupInfo } from './gateway/setup';
import { bridgePath, dataDir, fileExists } from './paths';
import { decryptBackup, encryptBackup } from './backup';
import { isTrustedUrl } from './window';

function trusted(ctx: AppContext, event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const win = ctx.window();
  if (!win || event.sender !== win.webContents) return false;
  const url = event.senderFrame?.url ?? '';
  return isTrustedUrl(url);
}

function keyErrorMessage(err: unknown): never {
  if (err instanceof KeyError) {
    const prefix = err.code === 'needs-passphrase' ? 'NEEDS_PASSPHRASE: ' : err.code === 'bad-passphrase' ? 'BAD_PASSPHRASE: ' : '';
    throw new Error(prefix + err.message);
  }
  throw err;
}

const CONNECTION_FIELDS: (keyof Host)[] = ['hostname', 'port', 'username', 'auth', 'keyId', 'jumpHostId', 'legacyAlgorithms'];

export function registerIpc(ctx: AppContext) {
  const { store, vault, pool, terminals, sftp, forwards, gateway, prompts } = ctx;

  // While the app is locked, only these channels are served. Everything else —
  // terminal writes, approvals, SFTP, host/settings changes — is refused in the
  // main process, so a lock screen drawn over the UI cannot be bypassed by
  // tabbing to a control underneath it.
  const LOCKED_ALLOWED = new Set([
    'app:snapshot', 'gateway:activity', 'app:unlock', 'app:quit', 'app:openExternal',
    'vault:unlock', 'vault:create', 'vault:reset', 'vault:retryKeychain',
  ]);
  const blockedWhileLocked = (channel: string) => ctx.ui.locked && !LOCKED_ALLOWED.has(channel);

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(ctx, event)) throw new Error('Untrusted sender');
      if (blockedWhileLocked(channel)) throw new Error('Gatehouse is locked.');
      return fn(...(args as A));
    });
  };
  const on = <A extends unknown[]>(channel: string, fn: (...args: A) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      if (!trusted(ctx, event)) return;
      if (blockedWhileLocked(channel)) return;
      try {
        fn(...(args as A));
      } catch (err) {
        console.warn(`[gatehouse] ${channel} failed:`, (err as Error).message);
      }
    });
  };
  const requireHost = (id: unknown): Host => {
    const host = typeof id === 'string' ? store.getHost(id) : undefined;
    if (!host) throw new Error('Host not found.');
    return host;
  };

  // App -------------------------------------------------------------------------
  handle('app:snapshot', () => buildSnapshot(ctx));
  handle('gateway:activity', () => gateway.recentActivity());

  handle('app:lock', () => {
    if (!ctx.touchId.available() && !vault.status().passwordWrap) {
      throw new Error('Set a master password (Settings → Security) to use the lock screen on this Mac.');
    }
    ctx.setUiLocked(true);
  });
  handle('app:unlock', async (password?: string) => {
    if (typeof password === 'string' && password) {
      const ok = vault.status().passwordWrap ? await vault.verifyPassword(password) : false;
      if (!ok) return { ok: false, error: 'Incorrect password.' };
      ctx.setUiLocked(false);
      return { ok: true };
    }
    if (ctx.touchId.available()) {
      const ok = await ctx.touchId.prompt('unlock Gatehouse');
      if (ok) ctx.setUiLocked(false);
      return ok ? { ok: true } : { ok: false, error: 'Touch ID was cancelled.' };
    }
    return { ok: false, error: 'Enter your master password.' };
  });
  handle('app:openExternal', async (url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened.');
    await shell.openExternal(url);
  });
  handle('app:showDataFolder', async () => {
    await shell.openPath(dataDir());
  });
  handle('app:clipboardWrite', (text: string) => clipboard.writeText(String(text ?? '')));
  handle('app:clipboardRead', () => clipboard.readText());
  handle(
    'app:contextMenu',
    (items: ContextMenuItem[]) =>
      new Promise<string | null>((resolve) => {
        let chosen: string | null = null;
        const template: MenuItemConstructorOptions[] = (Array.isArray(items) ? items : []).slice(0, 40).map((it) =>
          it.type === 'separator'
            ? { type: 'separator' }
            : {
                label: String(it.label ?? '').slice(0, 80),
                enabled: it.enabled !== false,
                accelerator: it.accelerator,
                click: () => {
                  chosen = it.id ?? null;
                },
              },
        );
        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window: ctx.window() ?? undefined, callback: () => setTimeout(() => resolve(chosen), 0) });
      }),
  );
  handle('app:quit', () => app.quit());

  handle('app:exportBackup', async (password: string) => {
    const payload = { store: store.data, secrets: vault.unlocked ? vault.exportSecrets() : null };
    const text = await encryptBackup(payload, String(password ?? ''));
    const res = await dialog.showSaveDialog(ctx.window()!, {
      title: 'Export encrypted backup',
      defaultPath: join(homedir(), 'Desktop', `Gatehouse-${new Date().toISOString().slice(0, 10)}.gatehouse-backup`),
    });
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, text, { mode: 0o600 });
    return res.filePath;
  });
  handle('app:importBackup', async (password: string) => {
    const res = await dialog.showOpenDialog(ctx.window()!, { title: 'Import backup', properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return { ok: false, message: 'Cancelled.' };
    const payload = await decryptBackup(readFileSync(res.filePaths[0], 'utf8'), String(password ?? ''));
    forwards.stopAll();
    terminals.closeAll();
    pool.disconnectAll();
    store.replaceAll(payload.store);
    if (payload.secrets && vault.unlocked) await vault.importSecrets(payload.secrets);
    ctx.onSettingsChanged();
    return { ok: true, message: `Restored ${payload.store.hosts.length} hosts and ${payload.store.keys.length} keys.` };
  });

  // Hosts -------------------------------------------------------------------------
  handle('hosts:save', async (draft: HostDraft, password?: string | null) => {
    const input = hostInputSchema.parse(draft);
    const existing = input.id ? store.getHost(input.id) : undefined;
    const id = existing?.id ?? randomUUID();
    const clash = store.data.hosts.find((h) => h.alias === input.alias && h.id !== id);
    if (clash) throw new Error(`The alias "${input.alias}" is already used by another host.`);
    if (input.jumpHostId && (input.jumpHostId === id || !store.getHost(input.jumpHostId))) throw new Error('Choose a valid jump host.');
    if (input.auth === 'key' && input.keyId && !store.getKey(input.keyId)) throw new Error('The selected key no longer exists.');
    const base = existing ?? newHost({ id }, store.settings.ai.defaultMode);
    const host: Host = {
      ...base,
      ...input,
      id,
      keyId: input.keyId ?? undefined,
      jumpHostId: input.jumpHostId ?? undefined,
      updatedAt: Date.now(),
    };
    const reconnect = existing && CONNECTION_FIELDS.some((f) => existing[f] !== host[f]);
    store.upsertHost(host);
    if (host.auth === 'password' && host.savePassword) {
      if (typeof password === 'string' && password.length) await vault.setHostPassword(id, password);
    } else if (vault.unlocked) {
      await vault.forgetHost(id);
    }
    if (password === null) await vault.forgetHost(id);
    if (reconnect) pool.disconnect(id);
    return host;
  });

  handle('hosts:remove', async (id: string) => {
    const host = requireHost(id);
    for (const t of terminals.list()) if (t.hostId === host.id) terminals.close(t.id);
    for (const f of store.data.forwards) if (f.hostId === host.id) forwards.forget(f.id);
    pool.disconnect(host.id);
    gateway.approvals.revoke(host.id);
    await vault.forgetHost(host.id).catch(() => undefined);
    store.deleteHost(host.id);
    pool.connLog.forget(host.id);
  });

  handle('hosts:duplicate', async (id: string) => {
    const src = requireHost(id);
    let alias = `${src.alias}-copy`.slice(0, 40);
    for (let i = 2; store.findHostByAlias(alias); i++) alias = `${src.alias}-${i}`.slice(0, 40);
    const copy: Host = {
      ...structuredClone(src),
      id: randomUUID(),
      alias,
      name: src.name ? `${src.name} (copy)` : '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastConnectedAt: undefined,
      favorite: false,
    };
    store.upsertHost(copy);
    const pw = vault.unlocked ? vault.getHostPassword(src.id) : undefined;
    if (pw) await vault.setHostPassword(copy.id, pw);
    return copy;
  });

  handle('hosts:test', async (id: string) => {
    const host = requireHost(id);
    const started = Date.now();
    let lease;
    try {
      lease = await pool.acquire(host.id, 'user');
      const latencyMs = Date.now() - started;
      const r = await execCommand(
        lease.client,
        "(grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"') || (sw_vers -productName 2>/dev/null && sw_vers -productVersion 2>/dev/null) || uname -sr",
        { timeoutMs: 15_000 },
      );
      const osInfo = r.stdout.trim().split('\n').join(' ').slice(0, 80) || undefined;
      if (osInfo) store.patchHost(host.id, { osInfo });
      return { ok: true, message: 'Connected successfully.', osInfo, latencyMs, attemptId: lease.attemptId };
    } catch (err) {
      if (isConnectError(err)) return { ok: false, message: err.message, attemptId: err.attemptId, cause: err.connCause, causeParams: err.connParams };
      return { ok: false, message: (err as Error).message };
    } finally {
      lease?.release();
    }
  });

  // Connection log -------------------------------------------------------------------
  handle('connlog:list', (hostId?: string) => pool.connLog.list(typeof hostId === 'string' ? hostId : undefined));
  handle('connlog:get', (id: string) => pool.connLog.get(String(id)) ?? null);
  handle('connlog:latest', (hostId: string) => pool.connLog.latest(String(hostId)) ?? null);
  handle('connlog:clear', (hostId: string) => {
    if (typeof hostId !== 'string' || !hostId) throw new Error('Host not found.');
    pool.connLog.clear(hostId);
  });

  handle('hosts:disconnect', (id: string) => {
    pool.disconnect(requireHost(id).id);
  });

  handle('hosts:copySshCommand', (id: string) => {
    const h = requireHost(id);
    clipboard.writeText(`ssh ${h.port !== 22 ? `-p ${h.port} ` : ''}${h.username ? `${h.username}@` : ''}${h.hostname}`);
  });

  handle('hosts:scanSshConfig', () =>
    parseSshConfig().map((c) => ({
      ...c,
      exists: store.data.hosts.some(
        (h) => h.alias === slugify(c.alias) || (h.hostname === c.hostname && h.port === c.port && h.username === c.username),
      ),
    })),
  );

  handle('hosts:importSshConfig', async (aliases: string[]) => {
    const wanted = new Set(Array.isArray(aliases) ? aliases : []);
    const candidates = parseSshConfig().filter((c) => wanted.has(c.alias));
    const created = new Map<string, Host>();
    const skipped: string[] = [];
    let keysImported = 0;
    const defaultIdentities = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((f) => join(homedir(), '.ssh', f));
    const keyForFile = async (file: string): Promise<string | undefined> => {
      try {
        if (!existsSync(file) || statSync(file).size > 64 * 1024) return undefined;
        const pem = await fsp.readFile(file, 'utf8');
        const { info, privateKey } = keyInfoFromPrivate(pem, { name: basename(file), savePassphrase: false, source: 'imported' });
        const dup = store.data.keys.find((k) => k.fingerprint === info.fingerprint);
        if (dup) return dup.id;
        await vault.setPrivateKey(info.id, privateKey);
        store.upsertKey(info);
        keysImported++;
        return info.id;
      } catch {
        return undefined; // encrypted or unsupported: fall back to the SSH agent
      }
    };
    for (const c of candidates) {
      let alias = slugify(c.alias);
      if (store.findHostByAlias(alias)) {
        const same = store.findHostByAlias(alias)!;
        if (same.hostname === c.hostname && same.port === c.port) {
          skipped.push(c.alias);
          continue;
        }
        for (let i = 2; store.findHostByAlias(alias); i++) alias = `${slugify(c.alias)}-${i}`.slice(0, 40);
      }
      let keyId: string | undefined;
      if (vault.unlocked) {
        if (c.identityFile) keyId = await keyForFile(c.identityFile);
        else for (const f of defaultIdentities) if ((keyId = await keyForFile(f))) break;
      }
      const host = newHost(
        {
          id: randomUUID(),
          alias,
          name: c.alias,
          hostname: c.hostname,
          port: c.port,
          username: c.username || process.env.USER || '',
          auth: keyId ? 'key' : 'agent',
          keyId,
          group: 'Imported',
        },
        store.settings.ai.defaultMode,
      );
      store.upsertHost(host);
      created.set(c.alias, host);
    }
    // Rebuild the full ProxyJump chain: `ProxyJump a,b` means client → a → b →
    // target, so target jumps through b, and b jumps through a. Each hop that
    // isn't a host we know is reported so the user can add it, not dropped silently.
    const unresolved = new Set<string>();
    const resolveHop = (name: string): string | undefined =>
      created.get(name)?.id ?? store.findHostByAlias(slugify(name))?.id;
    for (const c of candidates) {
      const host = created.get(c.alias);
      if (!host || !c.proxyJump || c.proxyJump === 'none') continue;
      const hops = c.proxyJump
        .split(',')
        .map((s) => s.trim().replace(/^.*@/, '').replace(/:\d+$/, ''))
        .filter(Boolean);
      if (!hops.length) continue;
      const chain = [...hops, c.alias];
      for (let i = chain.length - 1; i >= 1; i--) {
        const childId = chain[i] === c.alias ? host.id : resolveHop(chain[i]);
        if (!childId) continue;
        const parentId = resolveHop(chain[i - 1]);
        if (!parentId) {
          unresolved.add(chain[i - 1]);
          continue;
        }
        if (parentId !== childId) store.patchHost(childId, { jumpHostId: parentId });
      }
    }
    return { imported: created.size, keysImported, skipped, unresolvedJumps: [...unresolved] };
  });

  // Keys --------------------------------------------------------------------------
  handle('keys:generate', async (input: unknown) => {
    const opts = keyGenSchema.parse(input);
    const { info, privateKey } = generateKey(opts);
    await vault.setPrivateKey(info.id, privateKey);
    if (opts.passphrase && opts.savePassphrase) await vault.setKeyPassphrase(info.id, opts.passphrase);
    store.upsertKey(info);
    return info;
  });

  handle('keys:importText', async (input: unknown) => {
    const opts = keyImportSchema.parse(input);
    let material;
    try {
      material = keyInfoFromPrivate(opts.privateKey.trim() + '\n', {
        name: opts.name,
        passphrase: opts.passphrase || undefined,
        savePassphrase: opts.savePassphrase,
        source: 'imported',
      });
    } catch (err) {
      keyErrorMessage(err);
    }
    const dup = store.data.keys.find((k) => k.fingerprint === material.info.fingerprint);
    if (dup) throw new Error(`This key is already imported as "${dup.name}".`);
    await vault.setPrivateKey(material.info.id, material.privateKey);
    if (opts.passphrase && opts.savePassphrase) await vault.setKeyPassphrase(material.info.id, opts.passphrase);
    store.upsertKey(material.info);
    return material.info;
  });

  handle('keys:pickFile', async () => {
    const res = await dialog.showOpenDialog(ctx.window()!, {
      title: 'Choose a private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];
    if (statSync(file).size > 64 * 1024) throw new Error('That file is too large to be a private key.');
    return { name: basename(file), privateKey: readFileSync(file, 'utf8') };
  });

  handle('keys:rename', (id: string, name: string) => {
    const key = store.getKey(id);
    if (!key) throw new Error('Key not found.');
    store.upsertKey({ ...key, name: String(name).trim().slice(0, 80) || key.name });
  });

  handle('keys:remove', async (id: string) => {
    if (!store.getKey(id)) return;
    await vault.setPrivateKey(id, null);
    store.deleteKey(id);
  });

  handle('keys:copyPublic', (id: string) => {
    const key = store.getKey(id);
    if (key) clipboard.writeText(key.publicKey);
  });

  handle('keys:exportPublic', async (id: string) => {
    const key = store.getKey(id);
    if (!key) return null;
    const res = await dialog.showSaveDialog(ctx.window()!, {
      defaultPath: join(homedir(), 'Desktop', `${slugify(key.name)}.pub`),
    });
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, key.publicKey + '\n');
    return res.filePath;
  });

  handle('keys:deploy', async (keyId: string, hostId: string) => {
    const key = store.getKey(keyId);
    const host = requireHost(hostId);
    if (!key) throw new Error('Key not found.');
    const line = shellQuote(key.publicKey.trim());
    const script = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && if grep -qxF ${line} ~/.ssh/authorized_keys; then echo PRESENT; else printf '%s\\n' ${line} >> ~/.ssh/authorized_keys && echo ADDED; fi; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys`;
    const lease = await pool.acquire(host.id, 'user');
    try {
      const r = await execCommand(lease.client, script, { timeoutMs: 20_000 });
      if (r.stdout.includes('PRESENT')) return 'present';
      if (r.stdout.includes('ADDED')) return 'added';
      throw new Error(r.stderr.trim() || 'The server did not confirm the change.');
    } finally {
      lease.release();
    }
  });

  handle('knownHosts:remove', (id: string) => store.deleteKnownHost(String(id)));

  // Terminals ---------------------------------------------------------------------
  handle('term:open', (hostId: string, cols: number, rows: number) => {
    const host = requireHost(hostId);
    return terminals.open(host.id, host.name || host.alias, Number(cols) || 80, Number(rows) || 24, host.startupCommand);
  });
  on('term:write', (id: string, data: string) => terminals.write(String(id), String(data)));
  on('term:resize', (id: string, cols: number, rows: number) => terminals.resize(String(id), Number(cols), Number(rows)));
  on('term:ack', (id: string, bytes: number) => terminals.ack(String(id), Number(bytes) || 0));
  on('term:close', (id: string) => terminals.close(String(id)));
  on('term:reconnect', (id: string) => terminals.reconnect(String(id)));
  on('term:rename', (id: string, title: string) => terminals.rename(String(id), String(title)));

  // SFTP --------------------------------------------------------------------------
  const P = (p: unknown) => pathSchema.parse(p);
  handle('sftp:home', (hostId: string) => sftp.home(requireHost(hostId).id));
  handle('sftp:list', (hostId: string, path: string) => sftp.list(requireHost(hostId).id, typeof path === 'string' && path ? path : '.'));
  handle('sftp:mkdir', (hostId: string, path: string) => sftp.mkdir(requireHost(hostId).id, P(path)));
  handle('sftp:rename', (hostId: string, from: string, to: string) => sftp.rename(requireHost(hostId).id, P(from), P(to)));
  handle('sftp:remove', (hostId: string, paths: string[]) => sftp.remove(requireHost(hostId).id, (Array.isArray(paths) ? paths : []).map(P)));
  handle('sftp:chmod', (hostId: string, path: string, mode: number) => {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Invalid mode.');
    return sftp.chmod(requireHost(hostId).id, P(path), mode);
  });
  handle('sftp:readText', async (hostId: string, path: string) => {
    const r = await sftp.readFile(requireHost(hostId).id, P(path), { maxBytes: 5 * 1024 * 1024, initiatedBy: 'user' });
    const binary = r.data.subarray(0, 8192).includes(0);
    return { text: binary ? '' : r.data.toString('utf8'), size: r.size, binary, truncated: r.data.length < r.size };
  });
  handle('sftp:writeText', (hostId: string, path: string, text: string) =>
    sftp.writeFile(requireHost(hostId).id, P(path), Buffer.from(String(text), 'utf8'), { initiatedBy: 'user' }),
  );
  handle('sftp:download', async (hostId: string, paths: string[]) => {
    const host = requireHost(hostId);
    const res = await dialog.showOpenDialog(ctx.window()!, {
      title: 'Download to…',
      defaultPath: join(homedir(), 'Downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return false;
    sftp.download(host.id, (Array.isArray(paths) ? paths : []).map(P), res.filePaths[0]).catch((err) =>
      ctx.toast({ kind: 'error', title: 'Download failed', message: (err as Error).message }),
    );
    return true;
  });
  handle('sftp:upload', async (hostId: string, remoteDir: string, localPaths?: string[]) => {
    const host = requireHost(hostId);
    let files = Array.isArray(localPaths) ? localPaths.filter((f) => typeof f === 'string' && existsSync(f)) : [];
    if (!files.length) {
      const res = await dialog.showOpenDialog(ctx.window()!, {
        title: 'Upload',
        properties: ['openFile', 'openDirectory', 'multiSelections'],
      });
      if (res.canceled) return false;
      files = res.filePaths;
    }
    if (!files.length) return false;
    sftp.upload(host.id, files, P(remoteDir)).catch((err) =>
      ctx.toast({ kind: 'error', title: 'Upload failed', message: (err as Error).message }),
    );
    return true;
  });
  handle('sftp:cancelTransfer', (id: string) => sftp.cancel(String(id)));
  handle('sftp:clearTransfers', () => sftp.clearFinished());

  // Forwards ----------------------------------------------------------------------
  handle('forwards:save', async (draft: unknown) => {
    const input = forwardInputSchema.parse(draft);
    requireHost(input.hostId);
    if (input.type !== 'dynamic' && !input.destPort) throw new Error('Destination port is required.');
    const id = input.id && store.getForward(input.id) ? input.id : randomUUID();
    const f: PortForward = { ...newForward({ id, hostId: input.hostId }), ...input, id };
    const wasRunning = forwards.isRunning(id);
    if (wasRunning) forwards.stop(id);
    store.upsertForward(f);
    if (wasRunning) await forwards.start(f).catch(() => undefined);
    return f;
  });
  handle('forwards:remove', (id: string) => {
    forwards.forget(String(id));
    store.deleteForward(String(id));
  });
  handle('forwards:start', async (id: string) => {
    const f = store.getForward(String(id));
    if (!f) throw new Error('Tunnel not found.');
    await forwards.start(f);
  });
  handle('forwards:stop', (id: string) => forwards.stop(String(id)));

  // Snippets ----------------------------------------------------------------------
  handle('snippets:save', (draft: unknown) => {
    const input = snippetInputSchema.parse(draft);
    const existing = input.id ? store.getSnippet(input.id) : undefined;
    const s: Snippet = {
      ...(existing ?? newSnippet({ id: randomUUID() })),
      ...input,
      id: existing?.id ?? randomUUID(),
      updatedAt: Date.now(),
    };
    store.upsertSnippet(s);
    return s;
  });
  handle('snippets:remove', (id: string) => store.deleteSnippet(String(id)));

  // Gateway -----------------------------------------------------------------------
  handle('gateway:setEnabled', (enabled: boolean) => gateway.setEnabled(!!enabled));
  handle('gateway:decide', (id: string, decision: unknown) => gateway.approvals.decide(String(id), approvalDecisionSchema.parse(decision)));
  handle('gateway:revokeGrant', (hostId: string) => gateway.approvals.revoke(String(hostId)));
  handle('gateway:disconnectClients', () => gateway.disconnectClients());
  handle('gateway:clearActivity', () => gateway.clearActivity());
  handle('gateway:queryAudit', (q: unknown) => gateway.audit.query((q ?? {}) as Record<string, never>));
  handle('gateway:verifyAudit', () => gateway.audit.verify());
  handle('gateway:exportAudit', async (format: 'json' | 'csv') => {
    const fmt = format === 'csv' ? 'csv' : 'json';
    const res = await dialog.showSaveDialog(ctx.window()!, {
      defaultPath: join(homedir(), 'Desktop', `gatehouse-audit-${new Date().toISOString().slice(0, 10)}.${fmt}`),
    });
    if (res.canceled || !res.filePath) return null;
    await gateway.audit.exportTo(res.filePath, fmt);
    return res.filePath;
  });
  handle('gateway:setupInfo', () => setupInfo(bridgePath(), fileExists(bridgePath())));
  handle('gateway:installClaudeCode', () => installClaudeCode(bridgePath()));
  handle('gateway:installClaudeDesktop', () => installClaudeDesktop(bridgePath()));
  handle('gateway:selfTest', () => selfTest(bridgePath(), { ...process.env, GATEHOUSE_HOME: dataDir() }));
  handle('gateway:previewRedaction', (text: string) => {
    const r = redact(sanitizeOutput(String(text ?? '').slice(0, 200_000)), {
      settings: store.settings.ai.redaction,
      identities: gateway.identities(),
      tokens: new TokenMap(),
    });
    return r;
  });
  handle('gateway:previewCommand', (command: string, hostId?: string) => {
    const host = (hostId && store.getHost(hostId)) || newHost({ id: 'preview', alias: 'preview' }, 'ask');
    const picked = chooseShell(host);
    const kind = picked.ok ? picked.target.kind : 'posix';
    const assessment = assessShellCommand(String(command ?? ''), kind, gateway.classifierOptions());
    const d = decideCommand({ host, ai: store.settings.ai, security: store.settings.security, command: String(command ?? ''), assessment, grantActive: false });
    const detail = d.verdict === 'deny' ? d.message : d.verdict === 'ask' ? d.cause : d.by;
    return { assessment, verdict: d.verdict, detail: detail || assessment.reasons.map(describeReason).join('; ') };
  });
  handle('gateway:tokenMap', () => gateway.tokens.entries());

  // Settings ----------------------------------------------------------------------
  handle('settings:update', (patch: unknown) => {
    const before = store.settings.ai.enabled;
    store.updateSettings(patch);
    clampSettings(store.settings);
    if (before !== store.settings.ai.enabled) gateway.setEnabled(store.settings.ai.enabled);
    ctx.onSettingsChanged();
    return store.settings;
  });

  // Prompts / vault ------------------------------------------------------------------
  handle('prompts:respond', (id: string, response: PromptResponse) => prompts.respond(String(id), response ?? null));
  handle('vault:create', async (password?: string) => {
    if (vault.status().state !== 'uninitialized') throw new Error('The vault already exists.');
    await vault.create(password || undefined);
  });
  handle('vault:unlock', (password: string) => vault.unlockWithPassword(String(password ?? '')));
  handle('vault:retryKeychain', () => vault.retryKeychain());
  handle('vault:reset', async (password?: string) => {
    // Only allowed when the vault cannot be opened from disk (no password wrap).
    if (!vault.status().unrecoverable) throw new Error('The vault can still be unlocked; reset is not available.');
    await vault.reset(password || undefined);
  });
  handle('vault:setPassword', async (current: string | null, next: string | null) => {
    if (vault.status().passwordWrap) {
      if (!current || !(await vault.verifyPassword(current))) throw new Error('The current master password is incorrect.');
    }
    await vault.setPassword(next);
  });
  handle('vault:setKeychain', (enabled: boolean) => vault.setKeychainEnabled(!!enabled));
}
