import { IconCheck, IconClose, IconInfo, IconNeeds } from './icons';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

export interface ToastRecord {
  id: string;
  level: ToastLevel;
  message: string;
}

export interface ToastViewportProps {
  toasts: readonly ToastRecord[];
  onDismiss: (id: string) => void;
}

const TONE_CLASS: Record<ToastLevel, string> = {
  info: 'border-info/40 bg-info-soft text-info',
  success: 'border-success/40 bg-success-soft text-success',
  warn: 'border-warn/40 bg-warn-soft text-warn',
  error: 'border-danger/40 bg-danger-soft text-danger',
};

function ToastIcon({ level }: { level: ToastLevel }) {
  if (level === 'success') return <IconCheck size={15} />;
  if (level === 'warn' || level === 'error') return <IconNeeds size={15} />;
  return <IconInfo size={15} />;
}

export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-2 bottom-14 z-40 flex flex-col gap-1.5">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.level === 'error' ? 'alert' : 'status'}
          className={[
            'pointer-events-auto flex items-start gap-2 rounded-lg border px-2.5 py-2 shadow-[var(--shadow)]',
            TONE_CLASS[toast.level],
          ].join(' ')}
        >
          <span className="mt-0.5 shrink-0">
            <ToastIcon level={toast.level} />
          </span>
          <p className="min-w-0 flex-1 break-words text-[12px] font-medium leading-snug">
            {toast.message}
          </p>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
            className="-mr-1 -mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-current opacity-70 hover:opacity-100"
          >
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
