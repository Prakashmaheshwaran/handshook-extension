import type { AppError } from '@/core/contracts';
import { Button } from './Button';
import { IconNeeds } from './icons';
import { describeError } from './ui-copy';

export interface ErrorStateProps {
  error: AppError;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  error,
  title = 'Something went wrong',
  onRetry,
  retryLabel = 'Try again',
  className = '',
}: ErrorStateProps) {
  const description = describeError(error);
  return (
    <div
      role="alert"
      className={[
        'rounded-panel border border-danger/35 bg-danger-soft p-3.5 text-danger',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-start gap-2">
        <IconNeeds size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold">{title}</h3>
          <p className="mt-0.5 break-words text-[12px] leading-snug">{description.message}</p>
          <details className="mt-1 text-[10.5px] opacity-80">
            <summary className="cursor-pointer select-none">Advanced</summary>
            <p className="mt-0.5 break-words font-mono">{description.code}</p>
            {description.originalMessage ? (
              <p className="mt-0.5 break-words font-mono">{description.originalMessage}</p>
            ) : null}
          </details>
          {onRetry ? (
            <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
