/**
 * Handshook live-DOM capture sanitizer.
 *
 * This module is deliberately dependency-free and DOM-optional:
 * - the browser capture snippet concatenates it into a self-contained IIFE;
 * - `scripts/ingest-capture.ts` reuses it for a second sanitization pass in Node,
 *   passing a jsdom `DOMParser` through `options.parseHtml`;
 * - `tests/unit/capture-sanitize.test.ts` exercises it directly.
 *
 * It never reads cookies, storage, request headers, or resume contents. It only
 * rewrites strings and HTML that the caller already collected.
 */

/* global URL, URLSearchParams */

export const SANITIZER_VERSION = 1;

const STUDENT_PLACEHOLDER = 'Student A';
const PERSON_PLACEHOLDER = '[person]';
const EMAIL_PLACEHOLDER = '[email]';
const PHONE_PLACEHOLDER = '[phone]';
const TOKEN_PLACEHOLDER = '[token]';
const HANDLE_PLACEHOLDER = '[handle]';
const IMAGE_PLACEHOLDER = '[image]';

const EMAIL_SOURCE = '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}';
const PHONE_SOURCE =
  '(?<!\\d)(?:\\+?1[\\s.-]?)?(?:\\(\\d{3}\\)|\\d{3})[\\s.-]\\d{3}[\\s.-]\\d{4}(?!\\d)';
const INTL_PHONE_SOURCE = '(?<!\\d)\\+\\d{1,3}(?:[\\s.-]?\\d){7,14}(?!\\d)';
const JWT_SOURCE = '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b';
const BEARER_SOURCE = '\\bBearer\\s+[A-Za-z0-9._~+/=-]{12,}';
const NAMED_TOKEN_SOURCE =
  '\\b(?:csrf|xsrf|authenticity|access|refresh|id|session|api|auth)[_-]?token\\b(?:\\s*[:=]\\s*["\']?[A-Za-z0-9._~+/=-]{8,}["\']?)?';
const HEX_TOKEN_SOURCE = '\\b[a-f0-9]{32,}\\b';
const BASE64_TOKEN_SOURCE =
  '\\b(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\\d)[A-Za-z0-9+/_-]{40,}={0,2}\\b';
const HANDLE_SOURCE = '(^|\\s)@[A-Za-z0-9_.-]{2,}';

const EMAIL_PATTERN = new RegExp(EMAIL_SOURCE, 'gi');
const PHONE_PATTERN = new RegExp(PHONE_SOURCE, 'g');
const INTL_PHONE_PATTERN = new RegExp(INTL_PHONE_SOURCE, 'g');
const JWT_PATTERN = new RegExp(JWT_SOURCE, 'gi');
const BEARER_PATTERN = new RegExp(BEARER_SOURCE, 'gi');
const NAMED_TOKEN_PATTERN = new RegExp(NAMED_TOKEN_SOURCE, 'gi');
const HEX_TOKEN_PATTERN = new RegExp(HEX_TOKEN_SOURCE, 'gi');
const BASE64_TOKEN_PATTERN = new RegExp(BASE64_TOKEN_SOURCE, 'g');
const HANDLE_PATTERN = new RegExp(HANDLE_SOURCE, 'g');

const FILENAME_PATTERN =
  /(^|[\s"'(/])([A-Za-z0-9][A-Za-z0-9 _.,()'&+-]{0,80}?)\.(pdf|docx?|txt|rtf|odt)\b/gi;
const PLACEHOLDER_FILE =
  /^(?:Resume|Cover Letter|Transcript|Document) [A-Z][0-9]?\.(?:pdf|docx?|txt|rtf|odt)$/i;

const GREETING_PERSON_PATTERN =
  /\b(Hello|Hi|Welcome|Hey)[,!]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g;
const ROLE_PERSON_PATTERN =
  /\b(Posted by|Recruiter|Hiring manager|Hiring Manager|Contact|Advisor|Career advisor|Career Advisor|Interviewer)[:]?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gi;

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'state',
  'session',
  'session_id',
  'sessionid',
  'auth',
  'authorization',
  'csrf',
  'xsrf',
  'authenticity_token',
  'sig',
  'signature',
  'key',
  'api_key',
  'apikey',
  'secret',
  'password',
  'passwd',
  'email',
  'user',
  'user_id',
  'uid',
  'username',
  'ref',
  'referrer',
  'referral',
]);

const SENSITIVE_KEY_PATTERN =
  /token|secret|session|auth|csrf|xsrf|password|signature|api[-_]?key|email/i;

function isSensitiveQueryKey(key) {
  const lower = key.toLowerCase();
  return (
    lower.startsWith('utm_') || SENSITIVE_QUERY_KEYS.has(lower) || SENSITIVE_KEY_PATTERN.test(lower)
  );
}

const RESULTS_PER_PAGE = 25;
const DEFAULT_MAX_HTML = 800_000;

const IDENTITY_AREA =
  'nav, [class*="profile" i], [class*="avatar" i], [data-testid*="user" i], [data-testid*="account" i]';

const SANITIZE_NAV_LABELS = new Set([
  'career center',
  'career services',
  'documents',
  'employers',
  'events',
  'explore',
  'for you',
  'handshake',
  'help',
  'home',
  'job search',
  'log out',
  'logout',
  'messages',
  'my jobs',
  'my profile',
  'notifications',
  'profile',
  'saved',
  'settings',
  'sign out',
  'signout',
]);

const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'meta',
  'link',
  'base',
  'object',
  'embed',
]);

const DROPPED_ATTRIBUTES = new Set([
  'srcset',
  'srcdoc',
  'integrity',
  'nonce',
  'crossorigin',
  'referrerpolicy',
  'ping',
  'formaction',
]);

const TEXT_ATTRIBUTES = new Set([
  'alt',
  'title',
  'aria-label',
  'aria-description',
  'aria-valuetext',
  'placeholder',
]);

const URL_ATTRIBUTES = new Set(['src', 'href', 'action', 'poster', 'data-src']);

function collapse(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlaceholder(value) {
  return (
    value.includes(EMAIL_PLACEHOLDER) ||
    value.includes(PHONE_PLACEHOLDER) ||
    value.includes(TOKEN_PLACEHOLDER) ||
    value.includes(PERSON_PLACEHOLDER) ||
    value.includes(HANDLE_PLACEHOLDER) ||
    value.includes(IMAGE_PLACEHOLDER) ||
    value.includes(STUDENT_PLACEHOLDER) ||
    value === 'Employer A' ||
    value.startsWith('Resume ') ||
    value.startsWith('Cover Letter ') ||
    value.startsWith('Transcript ') ||
    value.startsWith('Document ')
  );
}

function mask(value) {
  const trimmed = String(value ?? '');
  if (trimmed.length <= 4) return '***';
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

function looksLikeToken(value) {
  const text = String(value ?? '').trim();
  if (!text || isPlaceholder(text)) return false;
  for (const pattern of [
    JWT_PATTERN,
    BEARER_PATTERN,
    NAMED_TOKEN_PATTERN,
    HEX_TOKEN_PATTERN,
    BASE64_TOKEN_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

function pathOf(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (raw.length === 0) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname.toLowerCase();
    } catch {
      return '';
    }
  }
  const withoutQuery = raw.split(/[?#]/)[0] ?? '';
  return (withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery).toLowerCase();
}

/**
 * Classify a Handshake page from its pathname plus DOM signals collected by the
 * snippet. Returns one of the fixture page-type names in `docs/SPIKE.md`.
 */
export function classifyPageType(pathnameOrUrl, signals = {}) {
  const path = pathOf(pathnameOrUrl);
  const loginPath =
    /^\/(?:login|log[-_]?in|signin|sign[-_]?in|sso|auth|users\/sign_in)(?:\/|$)/.test(path);
  const documentsPath = /^\/(?:stu\/|profile\/)?documents?(?:\/|$)/.test(path);
  const myJobsPath =
    /^\/(?:my[-_]jobs|my[-_]applications|applications|stu\/applications)(?:\/|$)/.test(path);
  const searchPath =
    /^\/(?:job-search|job_search|jobs|jobs\/search|postings|search|stu\/jobs|stu\/search)(?:\/|$)/.test(
      path,
    );
  const jobPath = /^\/(?:stu\/)?jobs\/\d+(?:\/|$)/.test(path);

  const modal = signals.modal === true;
  const questions = signals.questions === true;
  const applied = signals.applied === true;
  const applyType = typeof signals.applyType === 'string' ? signals.applyType : 'unknown';
  const jobLinks = Number(signals.jobLinks ?? 0);

  if (signals.login === true || loginPath) return 'login';
  if (signals.documents === true || documentsPath) return 'documents';
  if (signals.myJobs === true || myJobsPath) return 'my-jobs';

  if (jobPath || signals.job === true) {
    if (modal) return questions ? 'modal-questions' : 'modal-basic';
    if (applied) return 'job-applied';
    if (applyType === 'external') return 'job-external';
    if (applyType === 'quick_apply') return 'job-quick';
    if (applyType === 'handshake_form') return 'job-form';
    return 'job-detail';
  }

  if (signals.search === true || searchPath) return 'search';

  if (modal) return questions ? 'modal-questions' : 'modal-basic';
  if (jobLinks > 0) return 'search';
  if (signals.title === true && applyType !== 'unknown') {
    if (applyType === 'external') return 'job-external';
    if (applyType === 'quick_apply') return 'job-quick';
    return 'job-form';
  }
  return 'unknown';
}

function defaultParseHtml(html) {
  const Parser = globalThis.DOMParser;
  if (typeof Parser !== 'function') {
    throw new Error('DOMParser is unavailable; pass options.parseHtml');
  }
  return new Parser().parseFromString(html, 'text/html');
}

function redactInlinePatterns(value) {
  return value
    .replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER)
    .replace(PHONE_PATTERN, PHONE_PLACEHOLDER)
    .replace(INTL_PHONE_PATTERN, PHONE_PLACEHOLDER)
    .replace(HANDLE_PATTERN, (_match, prefix) => `${prefix}${HANDLE_PLACEHOLDER}`)
    .replace(JWT_PATTERN, TOKEN_PLACEHOLDER)
    .replace(BEARER_PATTERN, TOKEN_PLACEHOLDER)
    .replace(NAMED_TOKEN_PATTERN, TOKEN_PLACEHOLDER)
    .replace(HEX_TOKEN_PATTERN, TOKEN_PLACEHOLDER)
    .replace(BASE64_TOKEN_PATTERN, TOKEN_PLACEHOLDER);
}

function sanitizedSearch(params, resource) {
  if (resource) {
    const keys = [...new Set(params.keys())].filter((key) => !isSensitiveQueryKey(key));
    if (keys.length === 0) return '';
    return `?${keys.map((key) => `${encodeURIComponent(key)}=`).join('&')}`;
  }
  const output = new URLSearchParams();
  for (const key of [...new Set(params.keys())]) {
    if (isSensitiveQueryKey(key)) continue;
    output.set(key, redactInlinePatterns(params.get(key) ?? ''));
  }
  const value = output.toString();
  return value.length > 0 ? `?${value}` : '';
}

/**
 * Strip tracking/session material from a URL.
 *
 * Navigation URLs keep only a small allowlist of query keys (and their values,
 * still passed through PII redaction). Resource URLs keep parameter names but
 * drop every value, which preserves endpoint shape without leaking inputs.
 */
export function sanitizeUrl(rawUrl, options = {}) {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (raw.length === 0) return '';
  if (/^javascript:/i.test(raw)) return '[removed-url]';
  if (/^data:/i.test(raw)) return '[data-url]';
  if (/^mailto:/i.test(raw)) {
    return `mailto:${raw.slice('mailto:'.length).replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER)}`;
  }
  if (raw.startsWith('#')) {
    const anchor = raw.slice(1);
    return looksLikeToken(anchor) ? '#[token]' : `#${anchor}`;
  }

  let url;
  try {
    url = new URL(raw, 'https://handshake.invalid');
  } catch {
    return redactInlinePatterns(raw);
  }

  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const pathname = (() => {
    try {
      return redactInlinePatterns(decodeURIComponent(url.pathname));
    } catch {
      return redactInlinePatterns(url.pathname);
    }
  })();
  const search = sanitizedSearch(url.searchParams, options.resource === true);
  const origin = absolute ? `${url.protocol}//${url.host}` : '';
  return `${origin}${pathname}${search}`;
}

/** Resource-timing URL: endpoint path + parameter names, never values. */
export function sanitizeResourceUrl(rawUrl) {
  return sanitizeUrl(rawUrl, { resource: true });
}

/**
 * Find patterns that must never survive sanitization. Used by the ingest step
 * with a hard failure; samples are masked so the failure itself does not leak
 * the value to logs.
 */
export function findResidualPii(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings = [];
  const scan = (source) => {
    const scanPattern = (kind, pattern) => {
      const matches = source.match(pattern) ?? [];
      for (const match of matches) {
        if (isPlaceholder(match)) continue;
        findings.push({ kind, sample: mask(match) });
      }
    };
    scanPattern('email', new RegExp(EMAIL_SOURCE, 'gi'));
    scanPattern('phone', new RegExp(PHONE_SOURCE, 'g'));
    scanPattern('phone', new RegExp(INTL_PHONE_SOURCE, 'g'));
    scanPattern('token', new RegExp(JWT_SOURCE, 'gi'));
    scanPattern('token', new RegExp(BEARER_SOURCE, 'gi'));
    scanPattern('token', new RegExp(NAMED_TOKEN_SOURCE, 'gi'));
    scanPattern('token', new RegExp(HEX_TOKEN_SOURCE, 'gi'));
    scanPattern('token', new RegExp(BASE64_TOKEN_SOURCE, 'g'));
  };

  scan(text);
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) scan(decoded);
  } catch {
    /* Malformed percent escaping is not a PII finding by itself. */
  }

  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.kind}:${finding.sample}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function trimFilenameContext(filename) {
  const trimmed = filename
    .replace(/^(?:(?:and|or|also|the|a|an|uploaded|attached|downloaded|file)\s+)+/i, '')
    .trim();
  const leading = filename.slice(0, filename.length - trimmed.length);
  return { name: trimmed, leading };
}

function fileKind(filename) {
  if (/cover[\s_-]*letter/i.test(filename)) return 'Cover Letter';
  if (/resume|\bcv\b|curriculum/i.test(filename)) return 'Resume';
  if (/transcript/i.test(filename)) return 'Transcript';
  return 'Document';
}

function buildNameList(names) {
  const output = [];
  const seen = new Set();
  for (const raw of names ?? []) {
    const name = collapse(raw);
    if (name.length < 3 || name.length > 80) continue;
    if (!seen.has(name)) {
      seen.add(name);
      output.push(name);
    }
    const parts = name.split(' ');
    if (parts.length < 2) continue;
    for (const part of parts) {
      if (part.length < 4 || seen.has(part)) continue;
      if (/^(?:dr|mr|mrs|ms|prof)\.?$/i.test(part)) continue;
      seen.add(part);
      output.push(part);
    }
  }
  return output.sort((a, b) => b.length - a.length);
}

/**
 * Create a stateful sanitizer. File aliases and employer aliases stay stable
 * across a single capture so repeated mentions map to the same replacement.
 */
export function createSanitizer(options = {}) {
  const parseHtml = options.parseHtml ?? defaultParseHtml;
  const maxHtml = Number.isFinite(options.maxLength) ? Number(options.maxLength) : DEFAULT_MAX_HTML;
  const anonymizeEmployers = options.anonymizeEmployers === true;
  const studentPlaceholder =
    typeof options.studentPlaceholder === 'string' && options.studentPlaceholder.trim().length > 0
      ? options.studentPlaceholder.trim()
      : STUDENT_PLACEHOLDER;

  const redactions = {
    emails: 0,
    phones: 0,
    sensitiveValues: 0,
    names: 0,
    employers: 0,
    files: 0,
    personNames: 0,
    handles: 0,
    images: 0,
    hiddenInputs: 0,
    scripts: 0,
    styles: 0,
    meta: 0,
    elements: 0,
    dataAttributes: 0,
    formValues: 0,
    comments: 0,
  };
  const warnings = [];

  const userNames = buildNameList(options.userNames ?? []);
  const userPatterns = userNames.map((name) => ({
    pattern: new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'),
    caseSensitive: name.split(' ').length === 1,
  }));

  const employerNames = buildNameList(options.employerNames ?? []);
  const employerAliases = new Map();

  function employerAlias(name) {
    const existing = employerAliases.get(name.toLowerCase());
    if (existing) return existing;
    const index = employerAliases.size;
    const letter = String.fromCharCode(65 + (index % 26));
    const suffix = index >= 26 ? String(Math.floor(index / 26) + 1) : '';
    const alias = `Employer ${letter}${suffix}`;
    employerAliases.set(name.toLowerCase(), alias);
    return alias;
  }

  function isEmployerName(value) {
    const normalized = collapse(value).toLowerCase();
    return employerNames.some((name) => name.toLowerCase() === normalized);
  }

  const fileAliases = new Map();
  const fileCounters = { Resume: 0, 'Cover Letter': 0, Transcript: 0, Document: 0 };

  function fileAlias(filename) {
    const cleaned = collapse(filename);
    if (cleaned.length === 0) return cleaned;
    if (PLACEHOLDER_FILE.test(cleaned)) return cleaned;
    const key = cleaned.toLowerCase();
    const existing = fileAliases.get(key);
    if (existing) return existing;
    const kind = fileKind(cleaned);
    const index = fileCounters[kind] ?? 0;
    fileCounters[kind] = index + 1;
    const letter = String.fromCharCode(65 + (index % 26));
    const suffix = index >= 26 ? String(Math.floor(index / 26) + 1) : '';
    const extension = /\.([A-Za-z0-9]+)$/.exec(cleaned)?.[1]?.toLowerCase() ?? 'pdf';
    const alias = `${kind} ${letter}${suffix}.${extension}`;
    fileAliases.set(key, alias);
    redactions.files += 1;
    return alias;
  }

  function identityText(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    if (!/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(trimmed)) return value;
    if (SANITIZE_NAV_LABELS.has(trimmed.toLowerCase())) return value;
    if (isEmployerName(trimmed)) return value;
    redactions.personNames += 1;
    return value.replace(trimmed, studentPlaceholder);
  }

  function text(value) {
    if (typeof value !== 'string' || value.length === 0) return value;

    let output = value;

    if (anonymizeEmployers) {
      for (const employer of employerNames) {
        const pattern = new RegExp(`\\b${escapeRegExp(employer)}\\b`, 'gi');
        output = output.replace(pattern, () => {
          redactions.employers += 1;
          return employerAlias(employer);
        });
      }
    }

    for (const entry of userPatterns) {
      output = output.replace(entry.pattern, () => {
        redactions.names += 1;
        return studentPlaceholder;
      });
    }

    output = output.replace(GREETING_PERSON_PATTERN, (_match, greeting) => {
      redactions.personNames += 1;
      return `${greeting}, ${studentPlaceholder}`;
    });
    output = output.replace(ROLE_PERSON_PATTERN, (_match, role) => {
      redactions.personNames += 1;
      return `${role} ${PERSON_PLACEHOLDER}`;
    });

    output = output.replace(FILENAME_PATTERN, (_match, prefix, filename, extension) => {
      const { name, leading } = trimFilenameContext(filename);
      const alias = fileAlias(`${name}.${extension}`);
      return `${prefix}${leading}${alias}`;
    });

    output = output.replace(EMAIL_PATTERN, () => {
      redactions.emails += 1;
      return EMAIL_PLACEHOLDER;
    });
    output = output.replace(PHONE_PATTERN, () => {
      redactions.phones += 1;
      return PHONE_PLACEHOLDER;
    });
    output = output.replace(INTL_PHONE_PATTERN, () => {
      redactions.phones += 1;
      return PHONE_PLACEHOLDER;
    });
    output = output.replace(HANDLE_PATTERN, (_match, prefix) => {
      redactions.handles += 1;
      return `${prefix}${HANDLE_PLACEHOLDER}`;
    });
    output = output.replace(JWT_PATTERN, () => {
      redactions.sensitiveValues += 1;
      return TOKEN_PLACEHOLDER;
    });
    output = output.replace(BEARER_PATTERN, () => {
      redactions.sensitiveValues += 1;
      return TOKEN_PLACEHOLDER;
    });
    output = output.replace(NAMED_TOKEN_PATTERN, () => {
      redactions.sensitiveValues += 1;
      return TOKEN_PLACEHOLDER;
    });
    output = output.replace(HEX_TOKEN_PATTERN, () => {
      redactions.sensitiveValues += 1;
      return TOKEN_PLACEHOLDER;
    });
    output = output.replace(BASE64_TOKEN_PATTERN, () => {
      redactions.sensitiveValues += 1;
      return TOKEN_PLACEHOLDER;
    });

    return output;
  }

  function url(value) {
    return sanitizeUrl(text(value));
  }

  function resourceUrl(value) {
    return sanitizeResourceUrl(text(value));
  }

  function sanitizeAttribute(element, attribute) {
    const tag = element.tagName.toLowerCase();
    const name = attribute.name;
    const lower = name.toLowerCase();
    const value = attribute.value;

    if (lower.startsWith('on')) {
      element.removeAttribute(name);
      return;
    }

    if (lower === 'style') {
      if (/display\s*:\s*none/i.test(value)) {
        element.setAttribute('style', 'display: none');
      } else if (/visibility\s*:\s*hidden/i.test(value)) {
        element.setAttribute('style', 'visibility: hidden');
      } else {
        element.removeAttribute('style');
      }
      redactions.styles += 1;
      return;
    }

    if (DROPPED_ATTRIBUTES.has(lower)) {
      element.removeAttribute(name);
      return;
    }

    if (URL_ATTRIBUTES.has(lower)) {
      if ((tag === 'img' || tag === 'source' || tag === 'image') && lower === 'src') {
        element.setAttribute(name, IMAGE_PLACEHOLDER);
        redactions.images += 1;
        return;
      }
      element.setAttribute(name, url(value));
      return;
    }

    if (TEXT_ATTRIBUTES.has(lower)) {
      let next = text(value);
      if (
        lower === 'alt' &&
        /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(value.trim()) &&
        !isEmployerName(value)
      ) {
        next = '[avatar]';
        redactions.personNames += 1;
      }
      element.setAttribute(name, next);
      return;
    }

    if (lower === 'value') {
      if (tag === 'option') {
        element.setAttribute(name, looksLikeToken(value) ? TOKEN_PLACEHOLDER : text(value));
        return;
      }
      const inputType = (element.getAttribute('type') ?? '').toLowerCase();
      if (['checkbox', 'radio', 'submit', 'button', 'reset'].includes(inputType)) {
        element.setAttribute(name, text(value));
        return;
      }
      element.removeAttribute(name);
      if (value.length > 0) {
        element.setAttribute('data-handshook-value-present', 'true');
        redactions.formValues += 1;
      }
      return;
    }

    if (lower.startsWith('data-')) {
      if (/(token|secret|csrf|xsrf|auth|session|email|phone)/i.test(lower)) {
        element.removeAttribute(name);
        redactions.dataAttributes += 1;
        return;
      }
      if (looksLikeToken(value)) {
        element.setAttribute(name, TOKEN_PLACEHOLDER);
        redactions.sensitiveValues += 1;
        return;
      }
      const next = text(value);
      if (next !== value) element.setAttribute(name, next);
      return;
    }

    if (lower === 'id') {
      if (looksLikeToken(value)) {
        element.setAttribute(name, TOKEN_PLACEHOLDER);
        redactions.sensitiveValues += 1;
      }
      return;
    }

    if (lower === 'name') {
      if (/(?:csrf|xsrf|authenticity|session)/i.test(value)) {
        element.removeAttribute(name);
        redactions.dataAttributes += 1;
      }
      return;
    }

    if (lower === 'class' || lower === 'role' || lower === 'type' || lower === 'for') return;

    const next = text(value);
    if (next !== value) element.setAttribute(name, next);
  }

  function html(rawHtml) {
    if (typeof rawHtml !== 'string' || rawHtml.length === 0) return '';
    const doc = parseHtml(rawHtml);
    const body = doc?.body;
    if (!body) return '';

    const commentWalker = doc.createTreeWalker(body, 128);
    const comments = [];
    while (commentWalker.nextNode()) comments.push(commentWalker.currentNode);
    for (const comment of comments) {
      comment.remove();
      redactions.comments += 1;
    }

    for (const element of Array.from(body.querySelectorAll('*'))) {
      const tag = element.tagName.toLowerCase();
      if (BLOCKED_TAGS.has(tag)) {
        element.remove();
        if (tag === 'script') redactions.scripts += 1;
        else if (tag === 'style') redactions.styles += 1;
        else if (tag === 'meta' || tag === 'link' || tag === 'base') redactions.meta += 1;
        else redactions.elements += 1;
      }
    }

    for (const input of Array.from(body.querySelectorAll('input'))) {
      if ((input.getAttribute('type') ?? '').toLowerCase() === 'hidden') {
        input.remove();
        redactions.hiddenInputs += 1;
      }
    }

    for (const area of Array.from(body.querySelectorAll('textarea'))) {
      if (area.textContent && area.textContent.length > 0) {
        area.textContent = '[redacted]';
        redactions.formValues += 1;
      }
    }

    for (const element of Array.from(body.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        sanitizeAttribute(element, attribute);
      }
    }

    const textWalker = doc.createTreeWalker(body, 4);
    const nodes = [];
    while (textWalker.nextNode()) nodes.push(textWalker.currentNode);
    for (const node of nodes) {
      const value = node.nodeValue ?? '';
      let next = text(value);
      const parent = node.parentElement;
      if (parent && parent.closest(IDENTITY_AREA)) next = identityText(next);
      if (next !== value) node.nodeValue = next;
    }

    let output = body.innerHTML;
    if (output.length > maxHtml) {
      output = output.slice(0, maxHtml);
      warnings.push(`HTML truncated to ${maxHtml} characters`);
    }
    return output;
  }

  return {
    text,
    url,
    resourceUrl,
    html,
    redactions,
    warnings,
    studentPlaceholder,
  };
}

/** One-shot HTML sanitization with a fresh sanitizer. */
export function sanitizeHtml(rawHtml, options = {}) {
  return createSanitizer(options).html(rawHtml);
}

export const REDACTED = {
  student: STUDENT_PLACEHOLDER,
  person: PERSON_PLACEHOLDER,
  email: EMAIL_PLACEHOLDER,
  phone: PHONE_PLACEHOLDER,
  token: TOKEN_PLACEHOLDER,
  handle: HANDLE_PLACEHOLDER,
  image: IMAGE_PLACEHOLDER,
  resultsPerPage: RESULTS_PER_PAGE,
};
