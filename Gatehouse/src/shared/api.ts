// The contract between the sandboxed renderer and the main process.

import type {
  ActivityItem,
  AppSnapshot,
  ApprovalDecision,
  AuditEntry,
  AuditQueryInput,
  AuditVerifyInfo,
  CommandPreview,
  ContextMenuItem,
  ForwardDraft,
  Host,
  HostDraft,
  HostTestResult,
  ImportCandidate,
  KeyGenInput,
  KeyImportInput,
  MenuCommand,
  PortForward,
  PromptResponse,
  RedactionPreview,
  SelfTestResult,
  SetupInfo,
  Settings,
  SftpEntry,
  Snippet,
  SnippetDraft,
  SnapshotPatch,
  SshKeyInfo,
  Toast,
} from './types';

export interface GatehouseApi {
  platform: string;
  getSnapshot(): Promise<AppSnapshot>;
  getActivity(): Promise<ActivityItem[]>;

  on: {
    patch(cb: (patch: SnapshotPatch) => void): () => void;
    activity(cb: (item: ActivityItem) => void): () => void;
    activityReset(cb: () => void): () => void;
    terminalData(cb: (id: string, data: Uint8Array) => void): () => void;
    menu(cb: (cmd: MenuCommand) => void): () => void;
    toast(cb: (toast: Toast) => void): () => void;
  };

  hosts: {
    save(draft: HostDraft, password?: string | null): Promise<Host>;
    remove(id: string): Promise<void>;
    duplicate(id: string): Promise<Host>;
    test(id: string): Promise<HostTestResult>;
    disconnect(id: string): Promise<void>;
    scanSshConfig(): Promise<ImportCandidate[]>;
    importSshConfig(aliases: string[]): Promise<{ imported: number; keysImported: number; skipped: string[] }>;
    copySshCommand(id: string): Promise<void>;
  };

  keys: {
    generate(input: KeyGenInput): Promise<SshKeyInfo>;
    importText(input: KeyImportInput): Promise<SshKeyInfo>;
    pickFile(): Promise<{ name: string; privateKey: string } | null>;
    rename(id: string, name: string): Promise<void>;
    remove(id: string): Promise<void>;
    copyPublic(id: string): Promise<void>;
    exportPublic(id: string): Promise<string | null>;
    deploy(keyId: string, hostId: string): Promise<string>;
  };

  knownHosts: {
    remove(id: string): Promise<void>;
  };

  terminal: {
    open(hostId: string, cols: number, rows: number): Promise<string>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    ack(id: string, bytes: number): void;
    close(id: string): void;
    reconnect(id: string): void;
    rename(id: string, title: string): void;
  };

  sftp: {
    home(hostId: string): Promise<string>;
    list(hostId: string, path: string): Promise<{ path: string; entries: SftpEntry[] }>;
    mkdir(hostId: string, path: string): Promise<void>;
    rename(hostId: string, from: string, to: string): Promise<void>;
    remove(hostId: string, paths: string[]): Promise<void>;
    chmod(hostId: string, path: string, mode: number): Promise<void>;
    readText(hostId: string, path: string): Promise<{ text: string; size: number; binary: boolean; truncated: boolean }>;
    writeText(hostId: string, path: string, text: string): Promise<void>;
    download(hostId: string, paths: string[]): Promise<boolean>;
    upload(hostId: string, remoteDir: string, localPaths?: string[]): Promise<boolean>;
    cancelTransfer(id: string): Promise<void>;
    clearTransfers(): Promise<void>;
    pathForFile(file: File): string;
  };

  forwards: {
    save(draft: ForwardDraft): Promise<PortForward>;
    remove(id: string): Promise<void>;
    start(id: string): Promise<void>;
    stop(id: string): Promise<void>;
  };

  snippets: {
    save(draft: SnippetDraft): Promise<Snippet>;
    remove(id: string): Promise<void>;
  };

  gateway: {
    setEnabled(enabled: boolean): Promise<void>;
    decide(id: string, decision: ApprovalDecision & { confirmText?: string }): Promise<{ ok: boolean; error?: string }>;
    revokeGrant(hostId: string): Promise<void>;
    disconnectClients(): Promise<void>;
    clearActivity(): Promise<void>;
    queryAudit(q: AuditQueryInput): Promise<{ entries: AuditEntry[]; total: number }>;
    verifyAudit(): Promise<AuditVerifyInfo>;
    exportAudit(format: 'json' | 'csv'): Promise<string | null>;
    setupInfo(): Promise<SetupInfo>;
    installClaudeCode(): Promise<{ ok: boolean; output: string }>;
    installClaudeDesktop(): Promise<{ ok: boolean; message: string }>;
    selfTest(): Promise<SelfTestResult>;
    previewRedaction(text: string): Promise<RedactionPreview>;
    previewCommand(command: string, hostId?: string): Promise<CommandPreview>;
    tokenMap(): Promise<[string, string][]>;
  };

  settings: {
    update(patch: unknown): Promise<Settings>;
  };

  prompts: {
    respond(id: string, response: PromptResponse): Promise<void>;
  };

  vault: {
    create(password?: string): Promise<void>;
    unlock(password: string): Promise<boolean>;
    setPassword(current: string | null, next: string | null): Promise<void>;
    setKeychain(enabled: boolean): Promise<void>;
  };

  app: {
    lock(): Promise<void>;
    unlock(password?: string): Promise<{ ok: boolean; error?: string }>;
    openExternal(url: string): Promise<void>;
    showDataFolder(): Promise<void>;
    clipboardWrite(text: string): Promise<void>;
    clipboardRead(): Promise<string>;
    contextMenu(items: ContextMenuItem[]): Promise<string | null>;
    exportBackup(password: string): Promise<string | null>;
    importBackup(password: string): Promise<{ ok: boolean; message: string }>;
    quit(): Promise<void>;
  };
}

declare global {
  interface Window {
    gatehouse: GatehouseApi;
  }
}
