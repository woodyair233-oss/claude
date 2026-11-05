import { useEffect, useMemo, useState } from 'react';
import { ClipboardPaste, Search } from 'lucide-react';
import { create } from 'zustand';
import { useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { setPasteGuard } from '../lib/terminal-registry';
import { Modal, ModalHeader } from './overlays';
import { Button, Input } from './ui';
import { HostDot, ModeBadge } from './domain';

export function HostPicker() {
  const picker = useApp((s) => s.hostPicker);
  const close = useApp((s) => s.closeHostPicker);
  const hosts = useApp((s) => s.snap?.hosts ?? []);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  useEffect(() => {
    setQ('');
    setSel(0);
  }, [picker]);
  const list = useMemo(
    () =>
      hosts
        .filter((h) => !q || [h.name, h.alias, h.group, ...h.tags].some((s) => s.toLowerCase().includes(q.toLowerCase())))
        .sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0)),
    [hosts, q],
  );
  if (!picker) return null;
  return (
    <Modal onClose={() => close(null)}>
      <ModalHeader title={picker.title} />
      <div className="modal-body" style={{ paddingTop: 4 }}>
        <div className="input-group">
          <Search size={14} />
          <Input
            autoFocus
            value={q}
            placeholder={t('Search hosts')}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setSel((s) => Math.min(list.length - 1, s + 1));
              if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
              if (e.key === 'Enter' && list[sel]) close(list[sel].id);
            }}
          />
        </div>
        <div className="picker-list">
          {list.map((h, i) => (
            <button key={h.id} className={`pal-item ${i === sel ? 'sel' : ''}`} onMouseMove={() => setSel(i)} onClick={() => close(h.id)}>
              <HostDot color={h.color} />
              <span className="ellipsis" style={{ fontWeight: 550 }}>{h.name || h.alias}</span>
              <span className="mono faint ellipsis" style={{ fontSize: 11.5 }}>{h.alias}</span>
              <span style={{ marginLeft: 'auto' }}><ModeBadge mode={h.ai.mode} small /></span>
            </button>
          ))}
          {list.length === 0 && <div className="faint" style={{ padding: 16, textAlign: 'center' }}>{t('No hosts')}</div>}
        </div>
      </div>
    </Modal>
  );
}

const usePaste = create<{ text: string | null; resolve?: (ok: boolean) => void; set: (text: string | null, resolve?: (ok: boolean) => void) => void }>((set) => ({
  text: null,
  set: (text, resolve) => set({ text, resolve }),
}));

/** Confirms multi-line pastes into terminals (each line would run as a command). */
export function PasteGuard() {
  const { text, resolve, set } = usePaste();
  useEffect(() => {
    setPasteGuard((pasted) => new Promise((res) => usePaste.getState().set(pasted, res)));
  }, []);
  if (text === null) return null;
  const done = (ok: boolean) => {
    set(null);
    resolve?.(ok);
  };
  const lines = text.split('\n');
  return (
    <Modal onClose={() => done(false)}>
      <ModalHeader icon={<ClipboardPaste size={19} />} tone="amber" title={t('Paste {n} lines?', { n: lines.length })} subtitle={t('Each line may run as a separate command.')} />
      <div className="modal-body">
        <pre className="code" style={{ maxHeight: 240 }}>{lines.slice(0, 40).join('\n')}{lines.length > 40 ? '\n…' : ''}</pre>
      </div>
      <div className="modal-footer">
        <Button variant="ghost" onClick={() => done(false)}>{t('Cancel')}</Button>
        <Button variant="primary" autoFocus onClick={() => done(true)}>{t('Paste')}</Button>
      </div>
    </Modal>
  );
}
