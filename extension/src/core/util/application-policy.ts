import type { ApplyType, Job, QueueItem } from '@/core/contracts';

/** Persist dismissal without removing history or changing the terminal status. */
export const EXTERNAL_DISMISSED = 'External link dismissed';

export function isInternalApplication(type: ApplyType | undefined): boolean {
  return type === 'quick_apply' || type === 'handshake_form';
}

export function isExternalJob(
  job?: Pick<Job, 'applyType'>,
  item?: Pick<QueueItem, 'status' | 'lastError' | 'skipReason'>,
): boolean {
  return (
    job?.applyType === 'external' ||
    item?.status === 'external' ||
    item?.lastError?.code === 'EXTERNAL_APPLY' ||
    item?.skipReason === EXTERNAL_DISMISSED
  );
}

/** Only manually opened http(s) employer links; never credentials, scripts or Handshake routes. */
export function safeExternalUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      /(^|\.)joinhandshake\.(com|co\.uk)$/i.test(url.hostname)
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
