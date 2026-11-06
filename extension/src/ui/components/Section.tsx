import type { ReactNode } from 'react';

export interface SectionProps {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({
  id,
  title,
  description,
  actions,
  children,
  className = '',
}: SectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className={['scroll-mt-2', className].filter(Boolean).join(' ')}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className="text-[13.5px] font-semibold text-ink">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
