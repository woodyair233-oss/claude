import { useMemo, useState } from 'react';
import { Bot, Copy, Pencil, Play, Plus, Sparkles, Trash2, TriangleAlert, Zap } from 'lucide-react';
import type { Snippet, SnippetDraft } from '@shared/types';
import { assessCommand } from '@shared/command-policy';
import { api, attempt, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { runSnippetInTerminal } from '../lib/actions';
import { Toolbar } from '../components/Toolbar';
import { Button, Callout, EmptyState, Field, IconButton, Input, SearchField, Switch, TagInput, TextArea } from '../components/ui';
import { RiskBadge } from '../components/domain';
import { Modal, ModalHeader, confirmDialog } from '../components/overlays';

function SnippetEditor({ initial, onClose }: { initial?: Snippet; onClose: () => void }) {
  const ai = useApp((s) => s.snap!.settings.ai);
  const [d, setD] = useState<SnippetDraft>(initial ? { id: initial.id, name: initial.name, command: initial.command, description: initial.description, tags: initial.tags, aiAllowed: initial.aiAllowed } : { name: '', command: '', description: '', tags: [], aiAllowed: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const assessment = useMemo(() => (d.command.trim() ? assessCommand(d.command, { extraReadOnly: ai.extraReadOnlyCommands, dangerPatterns: ai.dangerPatterns, blockPatterns: ai.blockPatterns, sensitivePaths: ai.sensitivePaths }) : null), [d.command, ai]);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api().snippets.save(d);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Zap size={19} />} title={initial ? t('Edit snippet') : t('New snippet')} onClose={onClose} />
      <div className="modal-body">
        <Field label={t('Name')}>
          <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder={t('e.g. Restart web stack')} autoFocus />
        </Field>
        <Field label={t('Command')} extra={assessment && <RiskBadge risk={assessment.risk} small />}>
          <TextArea mono value={d.command} onChange={(e) => setD({ ...d, command: e.target.value })} rows={4} placeholder="docker compose -f /srv/app/compose.yml ps" />
        </Field>
        <Field label={t('Description')}>
          <Input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </Field>
        <Field label={t('Tags')}>
          <TagInput value={d.tags} onChange={(tags) => setD({ ...d, tags })} placeholder={t('Add tag…')} />
        </Field>
        <div className="setting-row" style={{ padding: '10px 0', border: 0 }}>
          <div className="sr-text">
            <div className="sr-title row" style={{ gap: 6 }}><Bot size={14} color="var(--violet)" />{t('Claude may run this snippet')}</div>
            <div className="sr-desc">{t('Trusted snippets run without asking on Ask and Trusted hosts (read-only hosts still refuse anything that changes state).')}</div>
          </div>
          <Switch on={d.aiAllowed} onChange={(v) => setD({ ...d, aiAllowed: v })} />
        </div>
        {d.aiAllowed && assessment && assessment.risk !== 'read' && (
          <Callout tone={assessment.risk === 'danger' || assessment.risk === 'block' ? 'red' : 'amber'} icon={<TriangleAlert size={15} />}>
            {assessment.risk === 'block'
              ? t('This command is always blocked; Claude will not be able to run it.')
              : assessment.risk === 'danger'
                ? t('High-risk commands still ask for your approval, even as trusted snippets.')
                : t('This snippet changes state. Claude will be able to run it without asking.')}
          </Callout>
        )}
        {error && <div className="field"><div className="error" style={{ marginTop: 8 }}>{error}</div></div>}
      </div>
      <div className="modal-footer">
        <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="primary" loading={busy} disabled={!d.name.trim() || !d.command.trim()} onClick={() => void save()}>{t('Save')}</Button>
      </div>
    </Modal>
  );
}

export function SnippetsView() {
  const snippets = useApp((s) => s.snap!.snippets);
  const toast = useApp((s) => s.toast);
  const [editing, setEditing] = useState<Snippet | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const list = snippets.filter((s) => !query || [s.name, s.command, s.description, ...s.tags].some((x) => x.toLowerCase().includes(query.toLowerCase())));

  return (
    <>
      <Toolbar title={t('Snippets')} subtitle={t('Reusable commands')}>
        {snippets.length > 0 && <SearchField value={query} onChange={setQuery} width={200} />}
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>{t('New Snippet')}</Button>
      </Toolbar>
      <div className="content">
        {snippets.length === 0 ? (
          <EmptyState icon={<Zap size={40} strokeWidth={1.5} />} title={t('No snippets yet')} actions={<Button size="lg" variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>{t('New Snippet')}</Button>}>
            {t('Save commands you run often. Mark a snippet as trusted to let Claude run exactly that command without asking.')}
          </EmptyState>
        ) : (
          <div className="page">
            <div className="snippet-grid">
              {list.map((s) => (
                <div key={s.id} className="snippet-card card">
                  <div className="row" style={{ gap: 8 }}>
                    <strong className="grow ellipsis">{s.name}</strong>
                    {s.aiAllowed && <span className="badge violet sm" title={t('Claude may run this snippet')}><Sparkles size={10} />{t('Trusted for AI')}</span>}
                  </div>
                  <pre className="code snippet-code">{s.command}</pre>
                  {s.description && <div className="muted ellipsis" style={{ fontSize: 12 }}>{s.description}</div>}
                  <div className="row" style={{ marginTop: 'auto', gap: 4 }}>
                    {s.tags.slice(0, 3).map((tag) => <span key={tag} className="chip">{tag}</span>)}
                    <div className="spacer" />
                    <IconButton label={t('Copy')} small onClick={() => void api().app.clipboardWrite(s.command).then(() => toast({ kind: 'success', title: t('Copied') }))}><Copy size={13} /></IconButton>
                    <IconButton label={t('Edit')} small onClick={() => setEditing(s)}><Pencil size={13} /></IconButton>
                    <IconButton label={t('Delete')} small danger onClick={() => void confirmDialog({ title: t('Delete snippet "{name}"?', { name: s.name }), confirmLabel: t('Delete'), danger: true }).then((ok) => { if (ok) void attempt(() => api().snippets.remove(s.id), t('Could not delete snippet')); })}><Trash2 size={13} /></IconButton>
                    <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={() => void runSnippetInTerminal(s)}>{t('Run')}</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {editing && <SnippetEditor initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
