import { useState } from 'react';
import { Copy, FileKey, Fingerprint, KeyRound, MoreHorizontal, ServerCog, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import type { SshKeyInfo } from '@shared/types';
import { api, attempt, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { formatDate, relativeTime } from '../lib/format';
import { Toolbar } from '../components/Toolbar';
import { Button, EmptyState, IconButton } from '../components/ui';
import { confirmDialog, promptDialog } from '../components/overlays';
import { KeyGenDialog, KeyImportDialog } from './KeyDialogs';

function keyLabel(k: SshKeyInfo) {
  return k.type === 'rsa' ? `RSA ${k.bits ?? ''}`.trim() : k.type === 'ecdsa' ? `ECDSA P-${k.bits ?? 256}` : k.type === 'ed25519' ? 'Ed25519' : t('Unknown');
}

export function KeysView() {
  const keys = useApp((s) => s.snap!.keys);
  const hosts = useApp((s) => s.snap!.hosts);
  const known = useApp((s) => s.snap!.knownHosts);
  const toast = useApp((s) => s.toast);
  const pickHost = useApp((s) => s.pickHost);
  const [dialog, setDialog] = useState<'gen' | 'import' | null>(null);

  const deploy = async (k: SshKeyInfo) => {
    const hostId = await pickHost(t('Install "{name}" on…', { name: k.name }));
    if (!hostId) return;
    const host = hosts.find((h) => h.id === hostId);
    const r = await attempt(() => api().keys.deploy(k.id, hostId), t('Could not install key'));
    if (!r) return;
    toast({ kind: 'success', title: r === 'present' ? t('Key was already installed') : t('Key installed on {name}', { name: host?.name || host?.alias || '' }) });
    if (host && (host.auth !== 'key' || host.keyId !== k.id)) {
      const use = await confirmDialog({ title: t('Use this key for {name}?', { name: host.name || host.alias }), message: t('Switch the host to key authentication with "{key}".', { key: k.name }), confirmLabel: t('Use Key') });
      if (use) {
        const { id, alias, name, hostname, port, username, savePassword, jumpHostId, group, tags, color, notes, keepAliveSec, startupCommand, favorite, legacyAlgorithms, ai } = host;
        await attempt(() => api().hosts.save({ id, alias, name, hostname, port, username, auth: 'key', keyId: k.id, savePassword, jumpHostId: jumpHostId ?? null, group, tags, color, notes, keepAliveSec, startupCommand, favorite, legacyAlgorithms, ai }), t('Could not update host'));
      }
    }
  };

  const menu = async (k: SshKeyInfo) => {
    const choice = await api().app.contextMenu([
      { id: 'copy', label: t('Copy Public Key') },
      { id: 'export', label: t('Export Public Key…') },
      { id: 'deploy', label: t('Install on Host…') },
      { type: 'separator' },
      { id: 'rename', label: t('Rename…') },
      { id: 'delete', label: t('Delete…') },
    ]);
    if (choice === 'copy') {
      await api().keys.copyPublic(k.id);
      toast({ kind: 'success', title: t('Public key copied') });
    }
    if (choice === 'export') void attempt(() => api().keys.exportPublic(k.id), t('Export failed'));
    if (choice === 'deploy') void deploy(k);
    if (choice === 'rename') {
      const name = await promptDialog({ title: t('Rename key'), initial: k.name });
      if (name) void attempt(() => api().keys.rename(k.id, name), t('Could not rename key'));
    }
    if (choice === 'delete') {
      const users = hosts.filter((h) => h.keyId === k.id);
      const ok = await confirmDialog({
        title: t('Delete key "{name}"?', { name: k.name }),
        message: users.length ? t('{n} host(s) use this key and will need another way to sign in.', { n: users.length }) : t('The private key is erased from the vault.'),
        confirmLabel: t('Delete'),
        danger: true,
      });
      if (ok) void attempt(() => api().keys.remove(k.id), t('Could not delete key'));
    }
  };

  return (
    <>
      <Toolbar title={t('Keys')} subtitle={t('SSH keys & trusted host fingerprints')}>
        <Button icon={<FileKey size={14} />} onClick={() => setDialog('import')}>{t('Import')}</Button>
        <Button variant="primary" icon={<Sparkles size={14} />} onClick={() => setDialog('gen')}>{t('Generate Key')}</Button>
      </Toolbar>
      <div className="content">
        <div className="page page-narrow">
          {keys.length === 0 ? (
            <EmptyState
              icon={<KeyRound size={40} strokeWidth={1.5} />}
              title={t('No SSH keys yet')}
              actions={
                <>
                  <Button size="lg" icon={<FileKey size={15} />} onClick={() => setDialog('import')}>{t('Import Existing Key')}</Button>
                  <Button size="lg" variant="primary" icon={<Sparkles size={15} />} onClick={() => setDialog('gen')}>{t('Generate Key')}</Button>
                </>
              }
            >
              {t('Keys are stored in the encrypted vault. Gatehouse can install the public key on a server for you.')}
            </EmptyState>
          ) : (
            <div className="card key-list">
              {keys.map((k) => {
                const used = hosts.filter((h) => h.keyId === k.id).length;
                return (
                  <div key={k.id} className="key-row" onContextMenu={(e) => { e.preventDefault(); void menu(k); }}>
                    <div className={`key-icon k-${k.type}`}><KeyRound size={16} /></div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <strong className="ellipsis">{k.name}</strong>
                        <span className="badge sm">{keyLabel(k)}</span>
                        {k.encrypted && <span className="badge sm violet" title={t('Protected by a passphrase')}><ShieldCheck size={10} />{t('Passphrase')}</span>}
                      </div>
                      <div className="mono faint ellipsis selectable" style={{ fontSize: 11.5, marginTop: 2 }}>
                        <Fingerprint size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                        {k.fingerprint}
                      </div>
                    </div>
                    <div className="faint" style={{ fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div>{used ? t('Used by {n} host(s)', { n: used }) : t('Not used')}</div>
                      <div>{formatDate(k.createdAt)}</div>
                    </div>
                    <IconButton label={t('Copy Public Key')} onClick={() => void api().keys.copyPublic(k.id).then(() => toast({ kind: 'success', title: t('Public key copied') }))}><Copy size={14} /></IconButton>
                    <IconButton label={t('Install on Host…')} onClick={() => void deploy(k)}><ServerCog size={14} /></IconButton>
                    <IconButton label={t('More')} onClick={() => void menu(k)}><MoreHorizontal size={14} /></IconButton>
                  </div>
                );
              })}
            </div>
          )}

          <div className="section-title" style={{ marginTop: 34 }}>
            <ShieldCheck size={15} color="var(--green)" /> {t('Trusted host keys')} <span className="muted">{known.length}</span>
          </div>
          <p className="muted" style={{ marginTop: -4 }}>{t('Gatehouse pins each server\'s host key the first time you connect and refuses to continue if it changes, which protects against man-in-the-middle attacks.')}</p>
          {known.length > 0 && (
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Host')}</th>
                    <th>{t('Key')}</th>
                    <th>{t('Fingerprint')}</th>
                    <th>{t('Last seen')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {known.map((k) => (
                    <tr key={k.id}>
                      <td className="mono">{k.host}{k.port !== 22 ? `:${k.port}` : ''}</td>
                      <td className="mono faint">{k.keyType.replace('ssh-', '')}</td>
                      <td className="mono faint ellipsis selectable" style={{ maxWidth: 260 }}>{k.fingerprint}</td>
                      <td className="faint">{relativeTime(k.lastSeenAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <IconButton label={t('Forget')} small danger onClick={() => void confirmDialog({ title: t('Forget this host key?'), message: t('You will be asked to verify the fingerprint again on the next connection.'), confirmLabel: t('Forget'), danger: true }).then((ok) => { if (ok) void api().knownHosts.remove(k.id); })}>
                          <Trash2 size={13} />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {dialog === 'gen' && <KeyGenDialog onClose={() => setDialog(null)} />}
      {dialog === 'import' && <KeyImportDialog onClose={() => setDialog(null)} />}
    </>
  );
}
