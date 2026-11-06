import { isAllowedHandshakeHost } from '@/core/contracts';

/**
 * M12: the only URLs the runner may visit are HTTPS Handshake URLs. Imported
 * searches/jobs and any legacy config are validated with this before storage.
 */
export function isAllowedHandshakeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && isAllowedHandshakeHost(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
