import { useEffect, useState } from 'react';
import { FileInput } from 'lucide-react';
import type { ImportCandidate } from '@shared/types';
import { api, attempt, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { Modal, ModalHeader } from '../components/overlays';
import { Button, Callout, EmptyState, Spinner } from '../components/ui';

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const [items, setItems] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void attempt(() => api().hosts.scanSshConfig(), t('Could not read ~/.ssh/config')).then((list) => {
      setItems(list ?? []);
      setSelected(new Set((list ?? []).filter((c) => !c.exists).map((c) => c.alias)));
    });
  }, []);

  const toggle = (alias: string) => {
    const next = new Set(selected);
    if (next.has(alias)) next.delete(alias);
    else next.add(alias);
    setSelected(next);
  };

  const run = async () => {
    setBusy(true);
    const r = await attempt(() => api().hosts.importSshConfig([...selected]), t('Import failed'));
    setBusy(false);
    if (!r) return;
    const notes = [
      r.keysImported ? t('{n} key(s) copied into the vault', { n: r.keysImported }) : '',
      r.unresolvedJumps.length ? t('Jump host(s) not imported: {list}', { list: r.unresolvedJumps.join(', ') }) : '',
    ].filter(Boolean);
    toast({
      kind: r.unresolvedJumps.length ? 'info' : 'success',
      title: t('Imported {n} host(s)', { n: r.imported }),
      message: notes.join(' · ') || undefined,
    });
    onClose();
  };

  return (
    <Modal onClose={onClose} size="wide">
      <ModalHeader icon={<FileInput size={19} />} title={t('Import from SSH config')} subtitle={t('Hosts from ~/.ssh/config (Include files are followed; Match blocks are skipped).')} onClose={onClose} />
      <div className="modal-body" style={{ paddingTop: 4 }}>
        {items === null ? (
          <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
            <Spinner large />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<FileInput size={34} />} title={t('No hosts found')}>
            {t('Your ~/.ssh/config has no concrete Host entries.')}
          </EmptyState>
        ) : (
          <>
            <Callout icon={<FileInput size={15} />}>
              {t('Unencrypted identity files are copied into the encrypted vault. Hosts with passphrase-protected keys use your SSH agent. New hosts start with the default AI access level.')}
            </Callout>
            <div className="card" style={{ marginTop: 12, maxHeight: 360, overflow: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}>
                      <input
                        type="checkbox"
                        checked={selected.size === items.length}
                        onChange={(e) => setSelected(new Set(e.target.checked ? items.map((i) => i.alias) : []))}
                      />
                    </th>
                    <th>{t('Host')}</th>
                    <th>{t('Address')}</th>
                    <th>{t('Key')}</th>
                    <th>{t('Jump')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.alias} className="clickable" onClick={() => toggle(c.alias)}>
                      <td>
                        <input type="checkbox" checked={selected.has(c.alias)} onChange={() => toggle(c.alias)} onClick={(e) => e.stopPropagation()} />
                      </td>
                      <td>
                        <span style={{ fontWeight: 550 }}>{c.alias}</span> {c.exists && <span className="badge sm">{t('exists')}</span>}
                      </td>
                      <td className="mono muted">
                        {c.username ? `${c.username}@` : ''}
                        {c.hostname}
                        {c.port !== 22 ? `:${c.port}` : ''}
                      </td>
                      <td className="mono faint ellipsis" style={{ maxWidth: 160 }}>
                        {c.identityFile?.replace(/^.*\//, '') ?? '—'}
                      </td>
                      <td className="mono faint">{c.proxyJump ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <span className="faint" style={{ marginRight: 'auto' }}>
          {items?.length ? t('{n} selected', { n: selected.size }) : ''}
        </span>
        <Button variant="ghost" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button variant="primary" onClick={run} loading={busy} disabled={!selected.size}>
          {t('Import {n}', { n: selected.size })}
        </Button>
      </div>
    </Modal>
  );
}
