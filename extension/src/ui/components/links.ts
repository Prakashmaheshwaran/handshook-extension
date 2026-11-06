/**
 * Handshake destinations used for "open it yourself" links. No API calls.
 *
 * Links are built from the configured `settings.host` when it is a valid
 * Handshake host (for example `app.joinhandshake.co.uk`), and fall back to the
 * US app otherwise.
 */
import { isHandshakeHost } from './ui-copy';

export const HANDSHAKE_FALLBACK_HOST = 'app.joinhandshake.com';

export interface HandshakeLinks {
  origin: string;
  home: string;
  jobs: string;
  documents: string;
}

export function handshakeLinks(host?: string | null): HandshakeLinks {
  const candidate = (host ?? '').trim().toLowerCase();
  const safeHost =
    candidate.length > 0 && isHandshakeHost(candidate) ? candidate : HANDSHAKE_FALLBACK_HOST;
  const origin = `https://${safeHost}`;
  return {
    origin,
    home: `${origin}/`,
    jobs: `${origin}/jobs`,
    documents: `${origin}/stu/documents`,
  };
}

/** Fallback links. Prefer `handshakeLinks(settings.host)` so links follow the host. */
export const HANDSHAKE_ORIGIN = `https://${HANDSHAKE_FALLBACK_HOST}`;
export const HANDSHAKE_HOME = `${HANDSHAKE_ORIGIN}/`;
export const HANDSHAKE_JOBS = `${HANDSHAKE_ORIGIN}/jobs`;
export const HANDSHAKE_DOCUMENTS = `${HANDSHAKE_ORIGIN}/stu/documents`;
