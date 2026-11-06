import type { ReactNode } from 'react';
import { IconExternal } from './icons';

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  /** Show the "opens in a new tab" icon. */
  withIcon?: boolean;
}

/**
 * Plain anchors keep the side panel permission-free. Every Handshake link opens
 * in a normal tab, never inside the panel.
 */
export function ExternalLink({
  href,
  children,
  className = '',
  withIcon = true,
}: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={[
        'inline-flex items-center gap-1 rounded text-[12px] font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="min-w-0 truncate">{children}</span>
      {withIcon ? <IconExternal size={12} className="shrink-0" /> : null}
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
