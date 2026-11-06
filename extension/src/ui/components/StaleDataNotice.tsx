import type { AppError } from '@/core/contracts';
import { Button } from './Button';
import { friendlyErrorMessage } from './ui-copy';

export interface StaleDataNoticeProps {
  error: AppError;
  /** What is still on screen, e.g. "Showing the last loaded queue". */
  context?: string;
  onRetry?: () => void;
  className?: string;
}

/**
 * Inline notice for a failed refresh while older data is still displayed.
 * Without this the screens silently show stale data when polling or a manual
 * refresh fails.
 */
export function StaleDataNotice({
  error,
  context = 'Showing the last loaded data',
  onRetry,
  className = '',
}: StaleDataNoticeProps) {
  return (
    <div
      role="status"
      className={[
        'flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/30 bg-warn-soft px-2 py-1.5 text-[11px] leading-snug text-warn',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="min-w-0 break-words">
        {context}. Refresh failed: {friendlyErrorMessage(error)}
      </span>
      {onRetry ? (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
