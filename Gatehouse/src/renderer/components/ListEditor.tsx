import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { t } from '../lib/i18n';
import { Button, Input } from './ui';

export function ListEditor({
  value,
  onChange,
  placeholder,
  validate,
  mono = true,
  emptyText,
  max = 200,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  validate?: (s: string) => string | null;
  mono?: boolean;
  emptyText?: string;
  max?: number;
}) {
  const [draft, setDraft] = useState('');
  const error = draft.trim() && validate ? validate(draft.trim()) : null;
  const add = () => {
    const v = draft.trim();
    if (!v || error || value.includes(v) || value.length >= max) return;
    onChange([...value, v]);
    setDraft('');
  };
  return (
    <div className="list-editor">
      {value.length > 0 ? (
        <ul>
          {value.map((item) => (
            <li key={item}>
              <span className={`grow ellipsis ${mono ? 'mono' : ''}`} title={item}>
                {item}
              </span>
              <button className="icon-btn sm danger" onClick={() => onChange(value.filter((x) => x !== item))} aria-label={t('Remove')}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        emptyText && <div className="le-empty faint">{emptyText}</div>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        <Input
          mono={mono}
          value={draft}
          placeholder={placeholder}
          invalid={!!error}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button icon={<Plus size={14} />} onClick={add} disabled={!draft.trim() || !!error}>
          {t('Add')}
        </Button>
      </div>
      {error && <div className="field"><div className="error" style={{ marginTop: 4 }}>{error}</div></div>}
    </div>
  );
}

export function validatePattern(s: string): string | null {
  const m = /^\/(.+)\/([imsu]*)$/.exec(s);
  if (m) {
    try {
      new RegExp(m[1], m[2]);
    } catch {
      return t('Invalid regular expression');
    }
  }
  return null;
}

export function validateRegex(s: string): string | null {
  try {
    new RegExp(s, 'i');
    return null;
  } catch {
    return t('Invalid regular expression');
  }
}
