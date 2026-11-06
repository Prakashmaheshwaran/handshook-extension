import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className = '' }: EmptyStateProps) {
  return (
    <div
      className={[
        'flex flex-col items-center gap-2 rounded-panel border border-dashed border-line bg-surface px-4 py-6 text-center',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon ? <div className="text-muted">{icon}</div> : null}
      <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
      <p className="max-w-[34ch] text-[12px] leading-snug text-muted">{description}</p>
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
