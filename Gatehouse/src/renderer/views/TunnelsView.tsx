import { useState } from 'react';
import { ArrowRight, Globe, Network, Pencil, Plus, Stethoscope, Trash2, TriangleAlert } from 'lucide-react';
import type { ForwardDraft, ForwardType, PortForward } from '@shared/types';
import { api, attempt, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { formatBytes } from '../lib/format';
import { causeTitle } from '../lib/conn';
import { Toolbar } from '../components/Toolbar';
import { Button, Callout, EmptyState, Field, IconButton, Input, Segmented, Select, Switch } from '../components/ui';
import { HostDot } from '../components/domain';
import { Modal, ModalHeader, confirmDialog } from '../components/overlays';

const TYPE_META: Record<ForwardType, { label: string; flag: string; desc: string }> = {
  local: { label: 'Local', flag: '-L', desc: 'Reach a service on (or behind) the server from this Mac, e.g. a database on the server\'s localhost.' },
  remote: { label: 'Remote', flag: '-R', desc: 'Expose a service on this Mac to the server.' },
  dynamic: { label: 'SOCKS proxy', flag: '-D', desc: 'A SOCKS5 proxy on this Mac that sends traffic through the server.' },
};

function TunnelEditor({ initial, onClose }: { initial?: PortForward; onClose: () => void }) {
  const hosts = useApp((s) => s.snap!.hosts);
  const [d, setD] = useState<ForwardDraft>(
    initial ?? { name: '', hostId: hosts[0]?.id ?? '', type: 'local', bindAddress: '127.0.0.1', bindPort: 15432, destHost: '127.0.0.1', destPort: 5432, autoStart: false },
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ForwardDraft>(k: K, v: ForwardDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const exposed = d.bindAddress !== '127.0.0.1' && d.bindAddress !== 'localhost' && d.bindAddress !== '::1';
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api().forwards.save({ ...d, name: d.name.trim() || `${TYPE_META[d.type].label} ${d.bindPort}` });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Network size={19} />} title={initial ? t('Edit tunnel') : t('New tunnel')} onClose={onClose} />
      <div className="modal-body">
        <Field label={t('Type')} hint={t(TYPE_META[d.type].desc)}>
          <Segmented
            block
            value={d.type}
            onChange={(v) => set('type', v)}
            options={(Object.keys(TYPE_META) as ForwardType[]).map((k) => ({ value: k, label: `${t(TYPE_META[k].label)} ${TYPE_META[k].flag}` }))}
          />
        </Field>
        <div className="field-row">
          <Field label={t('Name')}>
            <Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder={t('e.g. Postgres')} />
          </Field>
          <Field label={t('Through host')}>
            <Select value={d.hostId} onChange={(v) => set('hostId', v)} options={hosts.map((h) => ({ value: h.id, label: h.name || h.alias }))} />
          </Field>
        </div>
        <div className="field-label" style={{ marginBottom: 6 }}>{d.type === 'remote' ? t('Listen on the server') : t('Listen on this Mac')}</div>
        <div className="field-row r-3-1">
          <Field>
            <Input mono value={d.bindAddress} onChange={(e) => set('bindAddress', e.target.value.trim())} />
          </Field>
          <Field>
            <Input mono type="number" value={d.bindPort} onChange={(e) => set('bindPort', Number(e.target.value) || 0)} />
          </Field>
        </div>
        {d.type !== 'dynamic' && (
          <>
            <div className="field-label" style={{ marginBottom: 6 }}>{d.type === 'remote' ? t('Forward to (from this Mac)') : t('Forward to (from the server)')}</div>
            <div className="field-row r-3-1">
              <Field>
                <Input mono value={d.destHost} onChange={(e) => set('destHost', e.target.value.trim())} placeholder="127.0.0.1" />
              </Field>
              <Field>
                <Input mono type="number" value={d.destPort} onChange={(e) => set('destPort', Number(e.target.value) || 0)} />
              </Field>
            </div>
          </>
        )}
        {exposed && d.type !== 'remote' && (
          <Callout tone="amber" icon={<TriangleAlert size={15} />}>
            {t('Listening on {addr} makes this tunnel reachable from other devices on your network.', { addr: d.bindAddress })}
          </Callout>
        )}
        <label className="row" style={{ marginTop: 12 }}>
          <Switch on={d.autoStart} onChange={(v) => set('autoStart', v)} />
          <span>{t('Start automatically when Gatehouse opens')}</span>
        </label>
        {error && <div className="field"><div className="error" style={{ marginTop: 10 }}>{error}</div></div>}
      </div>
      <div className="modal-footer">
        <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="primary" loading={busy} disabled={!d.hostId || !d.bindPort} onClick={() => void save()}>{t('Save')}</Button>
      </div>
    </Modal>
  );
}

export function TunnelsView() {
  const forwards = useApp((s) => s.snap!.forwards);
  const status = useApp((s) => s.snap!.forwardStatus);
  const hosts = useApp((s) => s.snap!.hosts);
  const privacy = useApp((s) => s.snap!.settings.privacyMode);
  const [editing, setEditing] = useState<PortForward | 'new' | null>(null);

  const toggle = async (f: PortForward, on: boolean) => {
    await attempt(() => (on ? api().forwards.start(f.id) : api().forwards.stop(f.id)), on ? t('Could not start tunnel') : t('Could not stop tunnel'));
  };
  const remove = async (f: PortForward) => {
    if (await confirmDialog({ title: t('Delete tunnel "{name}"?', { name: f.name }), confirmLabel: t('Delete'), danger: true })) {
      await attempt(() => api().forwards.remove(f.id), t('Could not delete tunnel'));
    }
  };

  return (
    <>
      <Toolbar title={t('Tunnels')} subtitle={t('Port forwarding')}>
        <Button variant="primary" icon={<Plus size={15} />} disabled={!hosts.length} onClick={() => setEditing('new')}>
          {t('New Tunnel')}
        </Button>
      </Toolbar>
      <div className="content">
        {forwards.length === 0 ? (
          <EmptyState
            icon={<Network size={40} strokeWidth={1.5} />}
            title={t('No tunnels yet')}
            actions={<Button size="lg" variant="primary" icon={<Plus size={15} />} disabled={!hosts.length} onClick={() => setEditing('new')}>{t('New Tunnel')}</Button>}
          >
            {t('Forward ports securely through your servers — reach a remote database, expose a local dev server, or browse through a SOCKS proxy.')}
          </EmptyState>
        ) : (
          <div className="page page-narrow">
            <div className="tunnel-list">
              {forwards.map((f) => {
                const st = status[f.id];
                const host = hosts.find((h) => h.id === f.hostId);
                const running = st?.state === 'running';
                return (
                  <div key={f.id} className={`tunnel-card card ${running ? 'running' : ''}`}>
                    <div className={`tunnel-type t-${f.type}`}>{TYPE_META[f.type].flag}</div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <strong className="ellipsis">{f.name}</strong>
                        {running ? <span className="badge green sm"><span className="status-dot on" style={{ width: 5, height: 5 }} />{t('Running')}</span> : st?.state === 'error' ? <span className="badge red sm">{t('Error')}</span> : st?.state === 'starting' ? <span className="badge amber sm">{t('Starting…')}</span> : <span className="badge sm">{t('Stopped')}</span>}
                        {f.autoStart && <span className="badge outline sm">{t('Auto-start')}</span>}
                      </div>
                      <div className="tunnel-route mono">
                        <span>{f.type === 'remote' ? `${host?.alias ?? '?'}:` : 'localhost:'}{f.bindPort}</span>
                        <ArrowRight size={12} className="faint" />
                        <span className="row" style={{ gap: 5 }}><HostDot color={host?.color ?? 'gray'} size={6} />{host?.name || host?.alias || t('Missing host')}</span>
                        {f.type !== 'dynamic' ? (
                          <>
                            <ArrowRight size={12} className="faint" />
                            <span className={privacy ? 'privacy-blur' : ''}>{f.destHost}:{f.destPort}</span>
                          </>
                        ) : (
                          <>
                            <ArrowRight size={12} className="faint" />
                            <span className="row" style={{ gap: 4 }}><Globe size={12} />{t('anywhere')}</span>
                          </>
                        )}
                      </div>
                      {st?.state === 'error' && (
                        <div className="row tunnel-error" style={{ marginTop: 4, gap: 8 }}>
                          <span className="error-text ellipsis">
                            {st.cause ? causeTitle(st.cause, st.causeParams) : st.error === 'Connection to the host closed' ? t('Connection to the host closed') : st.error}
                          </span>
                          {st.attemptId && (
                            <button type="button" className="link-btn" onClick={() => useApp.getState().openConnLog(f.hostId, st.attemptId)}>
                              <Stethoscope size={11} />
                              {t('View details')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {running && (
                      <div className="tunnel-stats tnum">
                        <div><span className="faint">{t('Conns')}</span> {st.connections}</div>
                        <div><span className="faint">↓</span> {formatBytes(st.bytesIn)}</div>
                        <div><span className="faint">↑</span> {formatBytes(st.bytesOut)}</div>
                      </div>
                    )}
                    <IconButton label={t('Edit')} onClick={() => setEditing(f)}><Pencil size={14} /></IconButton>
                    <IconButton label={t('Delete')} danger onClick={() => void remove(f)}><Trash2 size={14} /></IconButton>
                    <Switch on={running || st?.state === 'starting'} tone="green" onChange={(v) => void toggle(f, v)} label={t('Running')} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {editing && <TunnelEditor initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
