export function now(): number {
  return Date.now();
}

export function todayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function minutes(value: number): number {
  return value * 60_000;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isWithinActiveHours(
  range: { start: string; end: string } | null,
  date = new Date(),
): boolean {
  if (!range) return true;
  const [startH, startM] = range.start.split(':').map(Number);
  const [endH, endM] = range.end.split(':').map(Number);
  if (
    startH === undefined ||
    startM === undefined ||
    endH === undefined ||
    endM === undefined ||
    Number.isNaN(startH) ||
    Number.isNaN(startM) ||
    Number.isNaN(endH) ||
    Number.isNaN(endM)
  ) {
    return true;
  }
  const current = date.getHours() * 60 + date.getMinutes();
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export function formatRelativeTime(at: number, base = Date.now()): string {
  const delta = at - base;
  const abs = Math.abs(delta);
  if (abs < 60_000) return 'now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
  return `${Math.round(abs / 86_400_000)}d`;
}
