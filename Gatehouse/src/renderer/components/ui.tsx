import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Check, Copy, Search, X } from 'lucide-react';
import { api } from '../lib/store';
import { t } from '../lib/i18n';

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft' | 'violet';

export function Button({
  variant = 'secondary',
  size,
  icon,
  loading,
  block,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'lg'; icon?: ReactNode; loading?: boolean; block?: boolean }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${block ? 'btn-block' : ''} ${className}`}
      disabled={rest.disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  active,
  small,
  danger,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; small?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-btn ${active ? 'active' : ''} ${small ? 'sm' : ''} ${danger ? 'danger' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }>(
  function Input({ mono, invalid, className = '', ...rest }, ref) {
    return <input ref={ref} className={`input ${mono ? 'mono' : ''} ${invalid ? 'invalid' : ''} ${className}`} spellCheck={false} autoComplete="off" {...rest} />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean; invalid?: boolean }>(
  function TextArea({ mono, invalid, className = '', ...rest }, ref) {
    return <textarea ref={ref} className={`textarea ${mono ? 'mono' : ''} ${invalid ? 'invalid' : ''} ${className}`} spellCheck={false} {...rest} />;
  },
);

export function SearchField({ value, onChange, placeholder, autoFocus, width }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; width?: number }) {
  return (
    <div className="input-group search-input no-drag" style={width ? { width } : undefined}>
      <Search size={14} />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? t('Search')} autoFocus={autoFocus} />
      {value && (
        <button className="icon-btn sm" style={{ position: 'absolute', right: 2 }} onClick={() => onChange('')} aria-label={t('Clear')}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function Select<T extends string>({ value, onChange, options, className = '', disabled }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string; disabled?: boolean }) {
  return (
    <select className={`select ${className}`} value={value} onChange={(e) => onChange(e.target.value as T)} disabled={disabled}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({ on, onChange, disabled, size, tone, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; size?: 'lg'; tone?: 'green'; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? 'on' : ''} ${size ?? ''} ${tone ?? ''}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

export function Segmented<T extends string>({ value, onChange, options, block }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: ReactNode; title?: string }[]; block?: boolean }) {
  return (
    <div className={`seg ${block ? 'block' : ''}`} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} title={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children, extra }: { label?: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="field">
      {label && (
        <label>
          {label}
          {extra && <span style={{ marginLeft: 'auto' }}>{extra}</span>}
        </label>
      )}
      {children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Badge({ tone, children, small, title, icon }: { tone?: 'green' | 'amber' | 'red' | 'violet' | 'blue' | 'teal' | 'outline'; children: ReactNode; small?: boolean; title?: string; icon?: ReactNode }) {
  return (
    <span className={`badge ${tone ?? ''} ${small ? 'sm' : ''}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function Spinner({ large }: { large?: boolean }) {
  return <span className={`spinner ${large ? 'lg' : ''}`} />;
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Card({ children, className = '', pad, style }: { children: ReactNode; className?: string; pad?: boolean; style?: React.CSSProperties }) {
  return (
    <div className={`card ${pad ? 'card-pad' : ''} ${className}`} style={style}>
      {children}
    </div>
  );
}

export function SettingRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="sr-text">
        <div className="sr-title">{title}</div>
        {desc && <div className="sr-desc">{desc}</div>}
      </div>
      <div className="sr-control">{children}</div>
    </div>
  );
}

export function Callout({ tone, icon, children }: { tone?: 'amber' | 'red' | 'violet' | 'green'; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={`callout ${tone ?? ''}`}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, children, actions }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-art">{icon}</div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function CopyButton({ text, label, small }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(id);
  }, [done]);
  const copy = async () => {
    await api().app.clipboardWrite(text);
    setDone(true);
  };
  if (label) {
    return (
      <Button size={small ? 'sm' : undefined} icon={done ? <Check size={14} /> : <Copy size={14} />} onClick={copy}>
        {done ? t('Copied') : label}
      </Button>
    );
  }
  return (
    <IconButton label={t('Copy')} small={small} onClick={copy} className="copy-btn">
      {done ? <Check size={13} /> : <Copy size={13} />}
    </IconButton>
  );
}

export function CodeBlock({ code, copy = true, className = '', children }: { code: string; copy?: boolean; className?: string; children?: ReactNode }) {
  return (
    <div className="copy-wrap">
      <pre className={`code ${className}`}>{children ?? code}</pre>
      {copy && <CopyButton text={code} small />}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; icon?: ReactNode; badge?: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tb) => (
        <button key={tb.value} role="tab" aria-selected={value === tb.value} className={value === tb.value ? 'on' : ''} onClick={() => onChange(tb.value)}>
          {tb.icon}
          {tb.label}
          {tb.badge}
        </button>
      ))}
    </div>
  );
}

/** Calls `fn` every `ms` while mounted (used for countdowns). */
export function useTicker(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useAutofocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const id = setTimeout(() => ref.current?.focus(), 30);
    return () => clearTimeout(id);
  }, []);
  return ref;
}

export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const tag = draft.trim().replace(/,$/, '');
    if (tag && !value.includes(tag)) onChange([...value, tag].slice(0, 20));
    setDraft('');
  };
  return (
    <div className="tag-input input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((tag) => (
        <span key={tag} className="chip">
          {tag}
          <button onClick={() => onChange(value.filter((x) => x !== tag))} aria-label={t('Remove')}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}
