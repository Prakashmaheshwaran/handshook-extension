/**
 * Read-only DOM collection for the Handshook live-capture snippet.
 *
 * Every helper reads the page. Nothing here clicks, focuses, submits, or
 * navigates. The returned object is already sanitized; callers only serialize
 * and download it.
 */

import {
  SANITIZER_VERSION,
  classifyPageType,
  createSanitizer,
  sanitizeResourceUrl,
} from './sanitize.js';

const MAX_BUTTONS = 300;
const MAX_CONTROLS = 300;
const MAX_HEADINGS = 80;
const MAX_QUESTIONS = 100;
const MAX_DOCUMENTS = 100;
const MAX_NETWORK = 200;
const MAX_JOB_IDS = 200;
const MAX_SHADOW_ROOTS = 50;
const MAX_IFRAMES = 30;

const DOCUMENT_LABEL = /\bresume\b|\bcv\b|\bcover\s*letter\b|\btranscript\b|\bother\s*document\b/i;
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

  const group = control.closest('[role="group"], [role="radiogroup"], [data-testid*="question" i]');
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
export function detectUserNames(doc) {
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
export function detectEmployerNames(doc, userNames) {
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
export function collectNetwork(perf) {
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

export function collectHeadings(doc, view, sanitizer) {
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

export function collectButtons(doc, view, sanitizer) {
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

export function collectFormControls(doc, view, sanitizer) {
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

export function collectQuestions(doc, view, sanitizer) {
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

export function collectDocuments(doc, sanitizer) {
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
        controlCount: shadow.querySelectorAll('input, select, textarea, [role="combobox"]').length,
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
export function collectCapture(doc, locationLike, perf, options = {}) {
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
