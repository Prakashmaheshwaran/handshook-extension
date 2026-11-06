/**
 * Job-ID and pagination parsing for discovery URLs and embedded data.
 */

import { isValidJobId } from './host';

// Live search results (2026-10-25) link cards to `/job-search/{id}`; the
// canonical detail route on the same tenant is `/jobs/{id}`. Both must parse.
const JOB_ID_PATTERNS = [
  /\/stu\/jobs\/(\d+)/i,
  /\/jobs\/(\d+)/i,
  /\/job\/(\d+)/i,
  /\/job-search\/(\d+)/i,
];
const EMBEDDED_JOB_ID = /"jobId"\s*:\s*"?(\d{1,20})"?/;
const ID_ATTRIBUTE = /^\d{1,20}$/;

/**
 * Extract a numeric job ID from an href, a `data-job-id` value, or a short
 * JSON snippet. Returns `null` for malformed/non-numeric IDs.
 */
export function extractJobId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (ID_ATTRIBUTE.test(trimmed)) return isValidJobId(trimmed) ? trimmed : null;

  for (const pattern of JOB_ID_PATTERNS) {
    const match = pattern.exec(trimmed);
    const id = match?.[1];
    if (id && isValidJobId(id)) return id;
  }

  const jsonMatch = EMBEDDED_JOB_ID.exec(trimmed);
  const jsonId = jsonMatch?.[1];
  if (jsonId && isValidJobId(jsonId)) return jsonId;
  return null;
}

/** JSON-only variant: never treats a URL inside the script as a job link. */
export function extractEmbeddedJobId(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = EMBEDDED_JOB_ID.exec(text);
  const id = match?.[1];
  return id && isValidJobId(id) ? id : null;
}

function asUrl(value: string | URL): URL | null {
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Current page number from `page` or `paged`; defaults to 1. */
export function readPageNumber(url: string | URL): number {
  const parsed = asUrl(url);
  if (!parsed) return 1;
  for (const key of ['page', 'paged']) {
    const raw = parsed.searchParams.get(key);
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 1) return value;
  }
  return 1;
}
