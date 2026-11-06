import { Spinner } from './Spinner';

export function Skeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={['space-y-2', className].filter(Boolean).join(' ')}>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className="h-3 animate-pulse rounded bg-surface-2"
          style={{ width: index === lines - 1 ? '65%' : '100%' }}
        />
      ))}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-8 text-muted">
      <Spinner size={16} />
      <span className="text-[12px]">{label}</span>
    </div>
  );
}
