import type { ReactNode } from 'react';

export function Toolbar({ title, subtitle, children, left }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode; left?: ReactNode }) {
  return (
    <header className="toolbar drag">
      {left}
      <h1>{title}</h1>
      {subtitle && <span className="subtitle">{subtitle}</span>}
      <div className="tb-actions">{children}</div>
    </header>
  );
}
