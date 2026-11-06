export const REDACTED = '[REDACTED]';

const SECRET_KEY =
  /cookie|passw|secret|token|api[-_ ]?key|credential|authorization|csrf|xsrf|private[-_ ]?key|session(?:id|key|data)|(^|[^a-z])(?:auth|session)([^a-z]|$)/i;
const PRIVATE_KEY =
  /email|phone|mobile|address|name|title|description|resume|answer|employer|company|keyword|user[-_]?id/i;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-or-[0-9A-Za-z_-]+/g, '[REDACTED_API_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{12,}/g, '[REDACTED_API_KEY]'],
  [/\b(?:sk-|gh[pousr]_|github_pat_)[0-9A-Za-z_-]{16,}/g, '[REDACTED_API_KEY]'],
  [/\b(?:Bearer|Basic)\s+[0-9A-Za-z._~+/-]+=*/gi, '[REDACTED_AUTH]'],
  [/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]'],
  // A Cookie header may contain many unrelated cookie names. Remove the whole
  // header, not just its first name=value pair.
  [/\b(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]+/gi, '[REDACTED_COOKIE]'],
  [
    /\b(?:[\w-]*(?:api[-_ ]?key|token|secret|password|session|csrf|xsrf|authorization|credential)[\w-]*)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
    '[REDACTED_CREDENTIAL]',
  ],
];

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function sanitizeUrl(raw: string, privateData: boolean): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    if (privateData) {
      url.search = '';
      url.pathname = url.pathname
        .split('/')
        .map((segment) => {
          const decoded = decodeURIComponent(segment);
          // Numeric IDs, UUIDs, hashes and opaque mixed-case/digit identifiers.
          return /^\d+$|\d{4,}|^[a-f0-9-]{16,}$|^(?=.*\d)[A-Za-z0-9_-]{16,}$/i.test(decoded)
            ? '[REDACTED_ID]'
            : segment;
        })
        .join('/');
    } else {
      for (const key of [...url.searchParams.keys()]) {
        if (SECRET_KEY.test(key) || /^(?:key|sid|code|samlresponse|ticket|signature)$/i.test(key)) {
          url.searchParams.delete(key);
        }
      }
    }
    return url.href;
  } catch {
    return '[REDACTED_URL]';
  }
}

/** Credentials only: personal backups must retain names, answers and job data. */
export function redactSecretsText(value: string, secrets: readonly string[] = []): string {
  let output = value;
  // Also remove an invalid/short key saved in settings, wherever it was copied.
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      output = output.split(form).join(REDACTED);
    }
  }
  output = output.replace(URL_PATTERN, (url) => sanitizeUrl(url, false));
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactText(value: string): string {
  return redactSecretsText(value.replace(URL_PATTERN, (url) => sanitizeUrl(url, true)))
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, '[REDACTED_EMAIL]')
    .replace(/(?<![\w])\+?\d[\d\s().-]{6,}\d(?:\s*(?:ext\.?|x)\s*\d+)?(?![\w])/gi, (candidate) =>
      candidate.replace(/\D/g, '').length >= 7 ? '[REDACTED_PHONE]' : candidate,
    )
    .replace(/\d{7,}/g, '[REDACTED_DIGITS]');
}

function redactObject(
  value: unknown,
  strings: (text: string) => string,
  keys: RegExp,
  depth: number,
): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') return strings(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, strings, keys, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        strings(key),
        keys.test(key) ? REDACTED : redactObject(entry, strings, keys, depth + 1),
      ]),
    );
  }
  return value;
}

export function redactSecretsData(value: unknown, secrets: readonly string[] = []): unknown {
  return redactObject(value, (text) => redactSecretsText(text, secrets), SECRET_KEY, 0);
}

/** Defense in depth for local logs; exports additionally use field allowlists. */
export function redactData(value: unknown, depth = 0): unknown {
  return redactObject(
    value,
    redactText,
    new RegExp(`${SECRET_KEY.source}|${PRIVATE_KEY.source}`, 'i'),
    depth,
  );
}
