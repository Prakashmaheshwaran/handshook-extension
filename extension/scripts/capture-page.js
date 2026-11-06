/*
 * Handshook live-DOM capture snippet (generated).
 *
 * Paste this entire file into the DevTools Console on a logged-in Handshake
 * page. It reads the page, downloads sanitized JSON, and copies the same JSON
 * to the clipboard. It never clicks, submits, or navigates.
 *
 * Source: scripts/capture/*.js — rebuild with
 *   node scripts/capture/build-snippet.mjs
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
/* global window, document, location, performance, navigator, Blob, URL, URLSearchParams, console */

(function () {
  'use strict';

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

  const SANITIZER_VERSION = 1;

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
      lower.startsWith('utm_') ||
      SENSITIVE_QUERY_KEYS.has(lower) ||
      SENSITIVE_KEY_PATTERN.test(lower)
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
    return (
      withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery
    ).toLowerCase();
  }

  /**
   * Classify a Handshake page from its pathname plus DOM signals collected by the
   * snippet. Returns one of the fixture page-type names in `docs/SPIKE.md`.
   */
  function classifyPageType(pathnameOrUrl, signals = {}) {
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
  function sanitizeUrl(rawUrl, options = {}) {
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
  function sanitizeResourceUrl(rawUrl) {
    return sanitizeUrl(rawUrl, { resource: true });
  }

  /**
   * Find patterns that must never survive sanitization. Used by the ingest step
   * with a hard failure; samples are masked so the failure itself does not leak
   * the value to logs.
   */
  function findResidualPii(text) {
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
  function createSanitizer(options = {}) {
    const parseHtml = options.parseHtml ?? defaultParseHtml;
    const maxHtml = Number.isFinite(options.maxLength)
      ? Number(options.maxLength)
      : DEFAULT_MAX_HTML;
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
  function sanitizeHtml(rawHtml, options = {}) {
    return createSanitizer(options).html(rawHtml);
  }

  const REDACTED = {
    student: STUDENT_PLACEHOLDER,
    person: PERSON_PLACEHOLDER,
    email: EMAIL_PLACEHOLDER,
    phone: PHONE_PLACEHOLDER,
    token: TOKEN_PLACEHOLDER,
    handle: HANDLE_PLACEHOLDER,
    image: IMAGE_PLACEHOLDER,
    resultsPerPage: RESULTS_PER_PAGE,
  };

  /**
   * Read-only DOM collection for the Handshook live-capture snippet.
   *
   * Every helper reads the page. Nothing here clicks, focuses, submits, or
   * navigates. The returned object is already sanitized; callers only serialize
   * and download it.
   */

  const MAX_BUTTONS = 300;
  const MAX_CONTROLS = 300;
  const MAX_HEADINGS = 80;
  const MAX_QUESTIONS = 100;
  const MAX_DOCUMENTS = 100;
  const MAX_NETWORK = 200;
  const MAX_JOB_IDS = 200;
  const MAX_SHADOW_ROOTS = 50;
  const MAX_IFRAMES = 30;

  const DOCUMENT_LABEL =
    /\bresume\b|\bcv\b|\bcover\s*letter\b|\btranscript\b|\bother\s*document\b/i;
  const CONFIRMATION_PATTERN =
    /you applied on|application submitted|application sent|application received|successfully applied|you have applied|already applied/i;
  const APPLIED_PATTERN = /you applied on|already applied|applied on/i;
  const COLLECT_NAV_LABELS = new Set([
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

  function collapseText(value) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeAttribute(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function readVisible(element, view) {
    if (!element || !element.isConnected) return false;
    if (
      element.tagName === 'INPUT' &&
      (element.getAttribute('type') ?? '').toLowerCase() === 'hidden'
    )
      return false;
    const body = view?.document?.body;
    let node = element;
    while (node && node !== body) {
      if (node.hasAttribute?.('hidden')) return false;
      if (node.getAttribute?.('aria-hidden') === 'true') return false;
      if (typeof view?.getComputedStyle === 'function') {
        const style = view.getComputedStyle(node);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (style.opacity !== '' && Number(style.opacity) === 0) return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function readAccessibleName(element, doc) {
    if (!element) return '';
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && collapseText(ariaLabel).length > 0) return collapseText(ariaLabel);

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? '')
        .filter((value) => collapseText(value).length > 0);
      if (parts.length > 0) return collapseText(parts.join(' '));
    }

    const id = element.getAttribute('id');
    if (id) {
      for (const label of Array.from(doc.querySelectorAll('label[for]'))) {
        if (label.getAttribute('for') === id) {
          const text = collapseText(label.textContent);
          if (text.length > 0) return text;
        }
      }
    }

    const wrapping = element.closest('label');
    if (wrapping) {
      const text = collapseText(wrapping.textContent);
      if (text.length > 0) return text;
    }

    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return collapseText(element.getAttribute('value'));
      }
      return '';
    }
    return collapseText(element.textContent);
  }

  function readLabel(control, doc) {
    const id = control.getAttribute('id');
    if (id) {
      for (const label of Array.from(doc.querySelectorAll('label[for]'))) {
        if (label.getAttribute('for') === id) {
          const text = collapseText(label.textContent);
          if (text.length > 0) return text;
        }
      }
    }

    const labelledBy = control.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((part) => doc.getElementById(part)?.textContent ?? '')
        .join(' ');
      if (collapseText(text).length > 0) return collapseText(text);
    }

    const aria = control.getAttribute('aria-label');
    if (aria && collapseText(aria).length > 0) return collapseText(aria);

    const type = (control.getAttribute('type') ?? '').toLowerCase();
    if (type === 'radio' || type === 'checkbox') {
      const legend = control.closest('fieldset')?.querySelector('legend');
      if (legend && collapseText(legend.textContent).length > 0) {
        return collapseText(legend.textContent);
      }
    }

    const wrapping = control.closest('label');
    if (wrapping && collapseText(wrapping.textContent).length > 0) {
      return collapseText(wrapping.textContent);
    }

    const fieldset = control.closest('fieldset');
    const legend = fieldset?.querySelector('legend');
    if (legend && collapseText(legend.textContent).length > 0) {
      return collapseText(legend.textContent);
    }

    const group = control.closest(
      '[role="group"], [role="radiogroup"], [data-testid*="question" i]',
    );
    const heading = group?.querySelector('legend, h3, h4, [role="heading"]');
    if (heading && collapseText(heading.textContent).length > 0) {
      return collapseText(heading.textContent);
    }

    let previous = control.previousElementSibling;
    let attempts = 0;
    while (previous && attempts < 3) {
      const text = collapseText(previous.textContent);
      if (text.length > 0) return text;
      previous = previous.previousElementSibling;
      attempts += 1;
    }
    return '';
  }

  function readSection(control) {
    const fieldset = control.closest('fieldset');
    const legend = fieldset?.querySelector('legend');
    if (legend && collapseText(legend.textContent).length > 0) {
      return collapseText(legend.textContent);
    }
    const container = control.closest('section, [role="group"], [data-testid*="question" i]');
    const heading = container?.querySelector('h2, h3, h4, [role="heading"]');
    return heading ? collapseText(heading.textContent) : '';
  }

  function safeValue(value, sanitizer) {
    return sanitizer.text(String(value ?? ''));
  }

  function optionDescriptors(control, doc, sanitizer) {
    const tag = control.tagName.toLowerCase();
    const options = [];

    if (tag === 'select') {
      for (const option of Array.from(control.options ?? [])) {
        if (option.value === '' && collapseText(option.textContent).length === 0) continue;
        options.push({
          label: sanitizer.text(collapseText(option.textContent)),
          value: safeValue(option.value, sanitizer),
        });
        if (options.length >= 80) break;
      }
      return options;
    }

    const type = (control.getAttribute('type') ?? '').toLowerCase();
    if (type === 'radio' || type === 'checkbox') {
      const name = control.getAttribute('name');
      if (!name) return options;
      for (const input of Array.from(doc.querySelectorAll('input'))) {
        if (input.getAttribute('name') !== name) continue;
        const id = input.getAttribute('id');
        let label = '';
        if (id) {
          for (const candidate of Array.from(doc.querySelectorAll('label[for]'))) {
            if (candidate.getAttribute('for') === id) {
              label = collapseText(candidate.textContent);
              break;
            }
          }
        }
        if (label.length === 0) label = collapseText(input.closest('label')?.textContent);
        if (label.length === 0) label = input.getAttribute('value') ?? '';
        options.push({ label: sanitizer.text(label), value: safeValue(input.value, sanitizer) });
        if (options.length >= 80) break;
      }
      return options;
    }

    if (control.getAttribute('role') === 'listbox') {
      for (const option of Array.from(control.querySelectorAll('[role="option"], option, li'))) {
        const label = collapseText(option.textContent);
        if (label.length === 0) continue;
        options.push({
          label: sanitizer.text(label),
          value: safeValue(
            option.getAttribute('data-value') ?? option.getAttribute('value') ?? '',
            sanitizer,
          ),
        });
        if (options.length >= 80) break;
      }
    }
    return options;
  }

  /** Detect the logged-in user's display name from nav/avatar affordances. */
  function detectUserNames(doc) {
    const names = new Set();
    const selectors = [
      '[data-testid*="user-name" i]',
      '[data-testid*="profile-name" i]',
      '[class*="user-name" i]',
      '[class*="userName" i]',
      '[class*="avatar" i] img[alt]',
      '[data-testid*="avatar" i] img[alt]',
      '[class*="profile" i] img[alt]',
      'nav img[alt]',
      'header img[alt]',
    ];

    const addCandidate = (raw, allowSingleWord) => {
      let value = collapseText(raw);
      if (value.length === 0) return;
      value = value.replace(/^(?:profile picture of|profile photo of|avatar for)\s+/i, '');
      value = value.replace(/\s+(?:avatar|profile picture|photo|logo|icon)$/i, '');
      if (/@|https?:|\d{3}[-.\s]\d{3}/.test(value)) return;
      if (/(?:logo|icon|banner|cover photo|company|employer)/i.test(value)) return;
      if (COLLECT_NAV_LABELS.has(value.toLowerCase())) return;
      const words = value.split(' ');
      if (words.length > 4) return;
      if (!allowSingleWord && words.length < 2) return;
      if (!words.every((word) => /^[A-Z][A-Za-z'’-]+$/.test(word))) return;
      names.add(value);
    };

    for (const selector of selectors) {
      for (const element of Array.from(doc.querySelectorAll(selector))) {
        if (element.tagName === 'IMG') addCandidate(element.getAttribute('alt'), false);
        else addCandidate(element.textContent, true);
        if (names.size >= 5) return [...names];
      }
    }
    return [...names];
  }

  /** Detect public employer names so they can optionally be anonymized. */
  function detectEmployerNames(doc, userNames) {
    const names = new Set();
    const title = collapseText(doc.querySelector('h1')?.textContent);
    const selectors = [
      '[data-testid*="employer" i]',
      '[data-testid*="company" i]',
      'a[href*="/companies/"]',
      'a[href*="/employers/"]',
      'h1 + p',
      'h1 + span',
      'h1 + div',
      'h1 + a',
    ];

    for (const selector of selectors) {
      for (const element of Array.from(doc.querySelectorAll(selector))) {
        const value = collapseText(element.textContent);
        if (value.length < 2 || value.length > 120) continue;
        if (value === title) continue;
        if (userNames.includes(value)) continue;
        if (/^\$|\d+\s*(?:\/|per)\s*(?:hour|hr|year|yr|month)/i.test(value)) continue;
        if (/^[^,]{2,48},\s*[a-z]{2}(?:\s|,|$)/i.test(value)) continue;
        if (
          /^(internship|intern|full[- ]?time|part[- ]?time|contract|temporary|remote|hybrid|on[- ]?site)$/i.test(
            value,
          )
        ) {
          continue;
        }
        names.add(value);
        if (names.size >= 10) return [...names];
      }
    }
    return [...names];
  }

  /** Resource-timing entries that look like Handshake API traffic. */
  function collectNetwork(perf) {
    if (!perf || typeof perf.getEntriesByType !== 'function') return [];
    let entries;
    try {
      entries = perf.getEntriesByType('resource');
    } catch {
      return [];
    }

    const output = [];
    const seen = new Set();
    for (const entry of entries) {
      const url = typeof entry?.name === 'string' ? entry.name : '';
      if (!/\/api(?:\/|$)|graphql|\/stu\//i.test(url)) continue;
      const cleaned = sanitizeResourceUrl(url);
      if (cleaned.length === 0 || seen.has(cleaned)) continue;
      seen.add(cleaned);
      output.push({
        url: cleaned,
        initiatorType: entry.initiatorType ?? 'other',
        method: null,
      });
      if (output.length >= MAX_NETWORK) break;
    }
    return output;
  }

  function collectHeadings(doc, view, sanitizer) {
    const output = [];
    for (const element of Array.from(
      doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'),
    )) {
      if (!readVisible(element, view)) continue;
      const text = sanitizer.text(collapseText(element.textContent));
      if (text.length === 0) continue;
      const tagLevel = Number(element.tagName.match(/^H([1-6])$/)?.[1] ?? '0');
      const ariaLevel = Number(element.getAttribute('aria-level') ?? '');
      output.push({
        level: tagLevel > 0 ? tagLevel : Number.isFinite(ariaLevel) ? ariaLevel : null,
        text,
      });
      if (output.length >= MAX_HEADINGS) break;
    }
    return output;
  }

  function collectButtons(doc, view, sanitizer) {
    const output = [];
    const selector =
      'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]';
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      if (!readVisible(element, view)) continue;
      const text = sanitizer.text(readAccessibleName(element, doc));
      if (text.length === 0) continue;
      const href = element.getAttribute('href');
      output.push({
        text,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        ariaLabel: element.getAttribute('aria-label')
          ? sanitizer.text(element.getAttribute('aria-label'))
          : null,
        testId: element.getAttribute('data-testid'),
        type: element.getAttribute('type'),
        disabled:
          element.hasAttribute('disabled') ||
          element.getAttribute('aria-disabled') === 'true' ||
          element.getAttribute('data-disabled') === 'true',
        href: href ? sanitizer.url(href) : null,
      });
      if (output.length >= MAX_BUTTONS) break;
    }
    return output;
  }

  function collectFormControls(doc, view, sanitizer) {
    const output = [];
    const selector =
      'input, select, textarea, [role="combobox"], [role="listbox"], [role="radio"], [role="checkbox"], [role="switch"], button[aria-haspopup]';
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      if (tag === 'input' && type === 'hidden') continue;
      const options = optionDescriptors(element, doc, sanitizer);
      output.push({
        tag,
        type: type || null,
        role: element.getAttribute('role'),
        id: element.getAttribute('id'),
        name: element.getAttribute('name'),
        label: sanitizer.text(readLabel(element, doc)),
        section: sanitizer.text(readSection(element)),
        placeholder: sanitizer.text(element.getAttribute('placeholder') ?? ''),
        ariaLabel: element.getAttribute('aria-label')
          ? sanitizer.text(element.getAttribute('aria-label'))
          : null,
        ariaLabelledby: element.getAttribute('aria-labelledby'),
        ariaRequired: element.getAttribute('aria-required'),
        ariaExpanded: element.getAttribute('aria-expanded'),
        ariaControls: element.getAttribute('aria-controls'),
        ariaHaspopup: element.getAttribute('aria-haspopup'),
        ariaInvalid: element.getAttribute('aria-invalid'),
        required:
          element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
        disabled:
          element.hasAttribute('disabled') ||
          element.getAttribute('aria-disabled') === 'true' ||
          element.getAttribute('data-disabled') === 'true',
        checked: tag === 'input' ? Boolean(element.checked) : element.getAttribute('aria-checked'),
        multiple: element.hasAttribute('multiple'),
        visible: readVisible(element, view),
        valuePresent: Boolean(element.getAttribute('value') || element.value),
        options,
      });
      if (output.length >= MAX_CONTROLS) break;
    }
    return output;
  }

  function questionType(control) {
    const tag = control.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (control.getAttribute('role') === 'combobox') return 'combobox';
    if (tag === 'input') {
      const type = (control.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'radio') return 'radio';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'date') return 'date';
      if (type === 'number') return 'number';
      if (type === 'text' || type === 'email' || type === 'tel' || type === 'url') return 'text';
      return 'unknown';
    }
    return 'unknown';
  }

  function collectQuestions(doc, view, sanitizer) {
    const scope = doc.querySelector('[role="dialog"], [aria-modal="true"]') ?? doc.body;
    const output = [];
    const seenGroups = new Set();
    const controls = Array.from(
      scope.querySelectorAll(
        'input, select, textarea, [role="combobox"], [role="radio"], [role="checkbox"]',
      ),
    );

    for (const control of controls) {
      const type = questionType(control);
      if (type === 'unknown' || !readVisible(control, view)) continue;
      if (control.hasAttribute('disabled')) continue;
      const tag = control.tagName.toLowerCase();
      if (tag === 'input') {
        const inputType = (control.getAttribute('type') ?? 'text').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'file', 'image'].includes(inputType)) continue;
      }

      const label = readLabel(control, doc);
      if (label.length === 0 || DOCUMENT_LABEL.test(label)) continue;

      const name = control.getAttribute('name');
      if ((type === 'radio' || type === 'checkbox') && name) {
        if (seenGroups.has(name)) continue;
        seenGroups.add(name);
      }

      const options = optionDescriptors(control, doc, sanitizer);
      if ((type === 'radio' || type === 'checkbox') && options.length === 0) continue;

      output.push({
        label: sanitizer.text(label),
        type,
        required:
          control.hasAttribute('required') ||
          control.getAttribute('aria-required') === 'true' ||
          /(^|\s)\*/.test(label) ||
          /\brequired\b/i.test(control.getAttribute('aria-label') ?? ''),
        section: sanitizer.text(readSection(control)),
        controlTag: tag,
        role: control.getAttribute('role'),
        name,
        options,
      });
      if (output.length >= MAX_QUESTIONS) break;
    }
    return output;
  }

  function inferDocumentType(text) {
    if (/cover\s*letter/i.test(text)) return 'cover_letter';
    if (/transcript/i.test(text)) return 'transcript';
    if (/resume|\bcv\b/i.test(text)) return 'resume';
    return 'other';
  }

  function collectDocuments(doc, sanitizer) {
    const byId = new Map();
    for (const element of Array.from(doc.querySelectorAll('a[href], [data-document-id]'))) {
      const href = element.getAttribute('href') ?? '';
      const dataId = element.getAttribute('data-document-id') ?? '';
      const match = /(?:\/docs?\/|\/documents\/|#)([A-Za-z0-9_-]{3,})/.exec(href);
      const id = dataId.length > 0 ? dataId : (match?.[1] ?? '');
      if (id.length === 0) continue;
      const text = sanitizer.text(collapseText(element.textContent));
      if (text.length === 0) continue;
      if (byId.has(id)) continue;
      const filenameMatch = /[^\s]+\.(pdf|docx?|txt|rtf)\b/i.exec(text);
      byId.set(id, {
        id: sanitizer.text(id),
        type: inferDocumentType(text),
        title: text,
        filename: filenameMatch ? sanitizer.text(filenameMatch[0]) : undefined,
      });
      if (byId.size >= MAX_DOCUMENTS) break;
    }
    return [...byId.values()];
  }

  function isPortal(dialog, doc) {
    const appRoot = doc.querySelector('#root, #app, [data-reactroot]');
    if (appRoot) return !appRoot.contains(dialog);
    return dialog.parentElement === doc.body;
  }

  function dialogFact(dialog, doc, view, sanitizer) {
    const heading = dialog.querySelector('h1, h2, h3, h4, legend, [role="heading"]');
    return {
      role: dialog.getAttribute('role'),
      ariaModal: dialog.getAttribute('aria-modal'),
      ariaLabel: sanitizer.text(dialog.getAttribute('aria-label') ?? ''),
      heading: sanitizer.text(collapseText(heading?.textContent)),
      testId: dialog.getAttribute('data-testid'),
      visible: readVisible(dialog, view),
      isPortal: isPortal(dialog, doc),
      controlCount: dialog.querySelectorAll(
        'input, select, textarea, [role="combobox"], button[aria-haspopup]',
      ).length,
    };
  }

  function collectIframes(doc, view, sanitizer) {
    const output = [];
    for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
      const fact = {
        src: sanitizer.url(frame.getAttribute('src') ?? ''),
        title: sanitizer.text(frame.getAttribute('title') ?? ''),
        role: frame.getAttribute('role'),
        visible: readVisible(frame, view),
        accessible: false,
        crossOrigin: false,
        dialogCount: null,
        controlCount: null,
        sanitizedHtml: null,
      };
      try {
        const inner = frame.contentDocument;
        if (inner) {
          fact.accessible = true;
          const dialogs = inner.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
          );
          fact.dialogCount = dialogs.length;
          fact.controlCount = inner.querySelectorAll(
            'input, select, textarea, [role="combobox"]',
          ).length;
          const last = dialogs[dialogs.length - 1];
          if (last) fact.sanitizedHtml = sanitizer.html(last.outerHTML);
        }
      } catch {
        fact.crossOrigin = true;
      }
      output.push(fact);
      if (output.length >= MAX_IFRAMES) break;
    }
    return output;
  }

  function collectShadowRoots(doc, sanitizer) {
    const output = [];
    const visit = (root, depth) => {
      if (depth > 3) return;
      for (const element of Array.from(root.querySelectorAll('*'))) {
        const shadow = element.shadowRoot;
        if (!shadow) continue;
        output.push({
          hostTag: element.tagName.toLowerCase(),
          hostId: element.getAttribute('id'),
          hostClass: element.getAttribute('class'),
          hostTestId: element.getAttribute('data-testid'),
          childCount: shadow.querySelectorAll('*').length,
          dialogCount: shadow.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
          ).length,
          controlCount: shadow.querySelectorAll('input, select, textarea, [role="combobox"]')
            .length,
          sanitizedHtml: sanitizer.html(shadow.innerHTML),
        });
        if (output.length >= MAX_SHADOW_ROOTS) return;
        visit(shadow, depth + 1);
        if (output.length >= MAX_SHADOW_ROOTS) return;
      }
    };
    visit(doc, 0);
    return output;
  }

  function findDocumentField(doc, view, sanitizer) {
    const root = doc.querySelector('[role="dialog"], [aria-modal="true"]') ?? doc.body;
    for (const labelElement of Array.from(root.querySelectorAll('label, legend, [aria-label]'))) {
      const label = collapseText(
        labelElement.textContent ?? labelElement.getAttribute('aria-label') ?? '',
      );
      if (label.length === 0 || label.length > 160 || !DOCUMENT_LABEL.test(label)) continue;

      let control = null;
      if (labelElement.tagName === 'LABEL') {
        const htmlFor = labelElement.getAttribute('for');
        if (htmlFor) control = doc.getElementById(htmlFor);
      }
      if (!control) {
        const container =
          labelElement.closest('fieldset, section, [role="group"], div') ??
          labelElement.parentElement;
        if (container) {
          control =
            Array.from(
              container.querySelectorAll(
                'input, select, textarea, [role="combobox"], button[aria-haspopup]',
              ),
            ).find((candidate) => readVisible(candidate, view)) ?? null;
        }
      }
      if (!control) continue;

      const tag = control.tagName.toLowerCase();
      const role = control.getAttribute('role');
      const fact = {
        label: sanitizer.text(label),
        tag,
        role,
        kind:
          tag === 'select'
            ? 'select'
            : role === 'combobox' || control.hasAttribute('aria-haspopup')
              ? 'combobox'
              : tag,
        optionValue: null,
        optionLabel: null,
      };
      if (tag === 'select') {
        const option = Array.from(control.options ?? []).find((entry) => entry.value !== '');
        if (option) {
          fact.optionValue = sanitizer.text(option.value);
          fact.optionLabel = sanitizer.text(collapseText(option.textContent));
        }
      }
      return fact;
    }
    return null;
  }

  function applyTypeFromButtons(buttons) {
    const names = buttons.map((button) => button.text.toLowerCase());
    if (
      names.some((name) =>
        /apply externally|apply external|external application|apply on (the )?(company|employer) (site|website)/.test(
          name,
        ),
      )
    ) {
      return 'external';
    }
    if (names.some((name) => /\bquick apply\b/.test(name))) return 'quick_apply';
    if (
      names.some((name) => /^(apply|apply now|apply to job|apply for this job)$/.test(name.trim()))
    ) {
      return 'handshake_form';
    }
    return 'unknown';
  }

  function collectConfirmationTexts(doc, view, sanitizer) {
    const output = [];
    const seen = new Set();
    for (const element of Array.from(
      doc.querySelectorAll('[role="alert"], [role="status"], h1, h2, p, span, div'),
    )) {
      if (!readVisible(element, view)) continue;
      const text = collapseText(element.textContent);
      if (text.length === 0 || text.length > 300) continue;
      if (!CONFIRMATION_PATTERN.test(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      output.push(sanitizer.text(text));
      if (output.length >= 10) break;
    }
    return output;
  }

  function collectJobIds(doc) {
    const ids = new Set();
    for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
      const match = /(?:stu\/)?jobs\/(\d{1,20})/.exec(anchor.getAttribute('href') ?? '');
      const id = match?.[1];
      if (id) ids.add(id);
      if (ids.size >= MAX_JOB_IDS) break;
    }
    return [...ids];
  }

  function hasVisiblePasswordField(doc, view) {
    return Array.from(doc.querySelectorAll('input[type="password"]')).some((input) =>
      readVisible(input, view),
    );
  }

  function hasLoginHeading(doc) {
    return /^(sign in to handshake|log in to handshake)$/i.test(
      collapseText(doc.querySelector('h1, h2, legend')?.textContent),
    );
  }

  /**
   * Collect the full sanitized capture payload.
   *
   * `locationLike` only needs `href`, `pathname`, and `hostname`, so tests can
   * pass a plain object instead of a live Location.
   */
  function collectCapture(doc, locationLike, perf, options = {}) {
    const view = doc.defaultView;
    const userNames = detectUserNames(doc);
    const employerNames = detectEmployerNames(doc, userNames);
    const sanitizer = createSanitizer({
      userNames,
      employerNames,
      anonymizeEmployers: options.anonymizeEmployers === true,
      maxLength: options.maxLength,
      parseHtml: options.parseHtml,
    });

    const buttons = collectButtons(doc, view, sanitizer);
    const formControls = collectFormControls(doc, view, sanitizer);
    const headings = collectHeadings(doc, view, sanitizer);
    const screeningQuestions = collectQuestions(doc, view, sanitizer);
    const documents = collectDocuments(doc, sanitizer);
    const confirmationTexts = collectConfirmationTexts(doc, view, sanitizer);
    const applyType = applyTypeFromButtons(buttons);

    const dialogElements = Array.from(
      doc.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]',
      ),
    ).filter((dialog) => readVisible(dialog, view));
    const dialogFacts = dialogElements.map((dialog) => dialogFact(dialog, doc, view, sanitizer));
    const iframes = collectIframes(doc, view, sanitizer);
    const shadowRoots = collectShadowRoots(doc, sanitizer);

    const mainElement = doc.querySelector('main, [role="main"], #main') ?? doc.body;
    const outsideDialogs = dialogElements.filter((dialog) => !mainElement.contains(dialog));
    const pieces = [sanitizer.html(mainElement.outerHTML)];
    for (const dialog of outsideDialogs) {
      pieces.push(sanitizer.html(dialog.outerHTML));
    }
    for (const shadow of shadowRoots) {
      if (shadow.controlCount === 0 && shadow.dialogCount === 0) continue;
      pieces.push(
        `<div data-handshook-shadow-root="${escapeAttribute(shadow.hostTag)}">${shadow.sanitizedHtml}</div>`,
      );
    }
    for (const frame of iframes) {
      if (!frame.sanitizedHtml) continue;
      pieces.push(
        `<div data-handshook-iframe-dialog="${escapeAttribute(frame.src)}">${frame.sanitizedHtml}</div>`,
      );
    }
    const sanitizedHtml = pieces.filter((piece) => piece.length > 0).join('\n');

    const jobIds = collectJobIds(doc);
    const detailTitle = sanitizer.text(
      collapseText(doc.querySelector('h1')?.textContent ?? doc.title),
    );
    const employer = employerNames.length > 0 ? sanitizer.text(employerNames[0]) : '';
    const applied = APPLIED_PATTERN.test(
      collapseText(
        typeof doc.body?.innerText === 'string'
          ? doc.body.innerText.slice(0, 5000)
          : doc.body?.textContent,
      ),
    );
    const passwordField = hasVisiblePasswordField(doc, view);
    const loginHeading = hasLoginHeading(doc);
    const isLogin = passwordField || loginHeading;

    const signals = {
      modal: dialogElements.length > 0,
      questions: screeningQuestions.length > 0,
      applyType,
      applied,
      login: isLogin,
      jobLinks: jobIds.length,
      title: detailTitle.length > 0,
      dialogCount: dialogElements.length,
      questionCount: screeningQuestions.length,
      documentCount: documents.length,
      passwordField,
      loginHeading,
      iframeCount: iframes.length,
      shadowRootCount: shadowRoots.length,
      portalCount: dialogFacts.filter((dialog) => dialog.isPortal).length,
    };

    const pathname = typeof locationLike?.pathname === 'string' ? locationLike.pathname : '';
    const pageType = classifyPageType(pathname || locationLike?.href || '', signals);

    const bodyText =
      typeof doc.body?.innerText === 'string' ? doc.body.innerText : (doc.body?.textContent ?? '');
    const visibleTextSample = sanitizer.text(collapseText(bodyText)).slice(0, 4000);

    const summary = {
      jobIds,
      title: detailTitle,
      employer,
      applyType,
      questionLabels: screeningQuestions.map((question) => question.label).slice(0, 50),
      requiredQuestionLabels: screeningQuestions
        .filter((question) => question.required)
        .map((question) => question.label)
        .slice(0, 50),
      documentCount: documents.length,
      documentTypes: [...new Set(documents.map((document) => document.type))],
      documentField: findDocumentField(doc, view, sanitizer),
      hasModal: dialogElements.length > 0,
      hasAppliedText: applied,
    };

    return {
      tool: 'handshook-capture',
      version: 1,
      sanitizerVersion: SANITIZER_VERSION,
      capturedAt: new Date().toISOString(),
      pageType,
      url: sanitizer.url(String(locationLike?.href ?? '')),
      host: collapseText(locationLike?.hostname ?? ''),
      title: sanitizer.text(collapseText(doc.title)),
      summary,
      signals,
      headings,
      buttons,
      formControls,
      screeningQuestions,
      documents,
      confirmationTexts,
      visibleTextSample,
      network: collectNetwork(perf),
      dom: {
        mainSelector: mainElement === doc.body ? 'body' : mainElement.tagName.toLowerCase(),
        sanitizedHtml,
        dialogCount: dialogElements.length,
        dialogs: dialogFacts,
        iframes,
        shadowRoots,
        portals: dialogFacts.filter((dialog) => dialog.isPortal),
        appRoots: ['#root', '#app', '[data-reactroot]'].filter((selector) =>
          Boolean(doc.querySelector(selector)),
        ),
      },
      sanitization: {
        version: SANITIZER_VERSION,
        anonymizeEmployers: options.anonymizeEmployers === true,
        studentPlaceholder: sanitizer.studentPlaceholder,
        redactions: { ...sanitizer.redactions },
        warnings: [...sanitizer.warnings],
      },
    };
  }

  /**
   * Console entry point for the Handshook live-DOM capture.
   *
   * This file is concatenated into `scripts/capture-page.js` by
   * `scripts/capture/build-snippet.mjs`. It only reads the page, triggers one
   * detached download, and copies the same JSON to the clipboard.
   *
   * Optional flags: set `window.HANDSHOOK_CAPTURE_OPTIONS = { anonymizeEmployers:
   * true }` before pasting the snippet to replace employer names with
   * `Employer A`, `Employer B`, ...
   */

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function timestamp(date) {
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      '-',
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join('');
  }

  function downloadJson(json, filename) {
    const blob = new Blob([json], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  }

  async function copyJson(json) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(json);
        return 'copied';
      }
    } catch {
      /* Clipboard permission can be denied on unfocused tabs; use the fallback. */
    }

    try {
      const area = document.createElement('textarea');
      area.value = json;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied ? 'copied (fallback)' : 'failed';
    } catch {
      return 'failed';
    }
  }

  function printSummary(capture, filename, clipboardStatus) {
    const redactions = capture.sanitization.redactions;
    const modal =
      capture.dom.dialogCount > 0 ? `${capture.dom.dialogCount} open dialog(s)` : 'no open dialog';
    console.log('');
    console.log('Handshook live capture complete');
    console.log(`  Page type : ${capture.pageType}`);
    console.log(`  URL       : ${capture.url}`);
    console.log(`  File      : ${filename}`);
    console.log(`  Clipboard : ${clipboardStatus}`);
    console.log(
      `  Collected : ${capture.buttons.length} buttons, ${capture.formControls.length} controls, ` +
        `${capture.screeningQuestions.length} questions, ${capture.documents.length} documents`,
    );
    console.log(
      `  Redacted  : ${redactions.emails} email(s), ${redactions.phones} phone(s), ` +
        `${redactions.sensitiveValues} token(s), ${redactions.names} name(s), ${redactions.files} file(s)`,
    );
    console.log(`  Modal     : ${modal}`);
    if (capture.dom.portals.length > 0) {
      console.log(`  Portal    : ${capture.dom.portals.length} dialog(s) outside the app root`);
    }
    if (capture.dom.shadowRoots.length > 0) {
      console.log(`  Shadow DOM: ${capture.dom.shadowRoots.length} open shadow root(s)`);
    }
    if (capture.dom.iframes.length > 0) {
      console.log(`  Iframes   : ${capture.dom.iframes.length} iframe(s)`);
    }
    for (const warning of capture.sanitization.warnings) {
      console.log(`  Warning   : ${warning}`);
    }
    if (clipboardStatus === 'failed') {
      console.log('  Clipboard was unavailable; the downloaded JSON is still complete.');
    }
    console.log('  No clicks, submissions, or navigation were performed.');
    console.log('');
  }

  async function main() {
    const configured =
      typeof window.HANDSHOOK_CAPTURE_OPTIONS === 'object' && window.HANDSHOOK_CAPTURE_OPTIONS
        ? window.HANDSHOOK_CAPTURE_OPTIONS
        : {};
    const options = {
      anonymizeEmployers: configured.anonymizeEmployers === true,
      maxLength: configured.maxLength,
    };

    const capture = collectCapture(document, location, performance, options);
    const filename = `handshook-capture-${capture.pageType}-${timestamp(new Date())}.json`;
    const json = JSON.stringify(capture, null, 2);

    downloadJson(json, filename);
    const clipboardStatus = await copyJson(json);
    printSummary(capture, filename, clipboardStatus);
  }

  void main().catch((error) => {
    console.error('[handshook-capture] Capture failed:', error);
  });
})();
