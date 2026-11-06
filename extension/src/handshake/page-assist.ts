import type {
  PageAssistCandidate,
  PageAssistScope,
  PageAssistTarget,
} from '@/core/contracts/pageAssist';
import {
  PAGE_ASSIST_ATTRIBUTES,
  PAGE_ASSIST_MAX_CANDIDATES,
  PAGE_ASSIST_TEXT_MAX,
} from '@/core/contracts/pageAssist';
import type { ApplyControl } from '@/core/contracts/submitAuthorization';
import { isDisabledElement, isVisible } from '@/handshake/dom';
import { collapseWhitespace, getAccessibleName } from '@/handshake/text';

export interface PageAssistOptions {
  /** Element whose descendants are candidates: the document for 'job', the dialog for 'dialog'. */
  root: ParentNode;
  scope: PageAssistScope;
  control?: ApplyControl;
  signal?: AbortSignal;
}

/**
 * The controls page assist may describe. Anything else — including hidden,
 * password and file inputs — is never offered to the model.
 */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="link"]',
  '[role="combobox"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="tab"]',
  'input:not([type="hidden"]):not([type="password"]):not([type="file"])',
  'select',
  'textarea',
].join(',');

const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

const BLOCKED_BUTTON_TEXT =
  /\b(?:withdraw|delete|remove|cancel|close|back|previous|save|share|follow|message|report|sign\s*out|log\s*out|upload|preview|hide|more)\b/i;

const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
const PHONE_PATTERN = /(?<![\w])\+?\d[\d\s().-]{6,}\d(?:\s*(?:ext\.?|x)\s*\d+)?(?![\w])/gi;
const LONG_DIGITS_PATTERN = /\d{7,}/g;

/** Mask personal identifiers before any label leaves the page. */
function maskIdentifiers(value: string): string {
  return value
    .replace(EMAIL_PATTERN, '[email]')
    .replace(PHONE_PATTERN, (candidate) =>
      candidate.replace(/\D/g, '').length >= 7 ? '[phone]' : candidate,
    )
    .replace(LONG_DIGITS_PATTERN, '[digits]');
}

/** Collapse, mask and bound every string described to the background/model. */
function describe(value: string | null | undefined): string {
  if (!value) return '';
  return maskIdentifiers(collapseWhitespace(value)).slice(0, PAGE_ASSIST_TEXT_MAX).trim();
}

function isFormControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'select' || tag === 'textarea';
}

function implicitRole(el: Element): string {
  switch (el.tagName.toLowerCase()) {
    case 'button':
      return 'button';
    case 'a':
      return 'link';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    default:
      return '';
  }
}

function isInDialog(el: Element): boolean {
  return el.closest(DIALOG_SELECTOR) !== null;
}

function describeAttributes(el: Element): PageAssistCandidate['attributes'] {
  const record: PageAssistCandidate['attributes'] = {};
  for (const name of PAGE_ASSIST_ATTRIBUTES) {
    const value = describe(el.getAttribute(name));
    if (value) record[name] = value;
  }
  return record;
}

/** Nearest label, legend or heading text, used only as disambiguating context. */
function nearestContext(el: Element): string {
  const label = describe(el.closest('label')?.textContent);
  if (label) return label;
  const fieldset = el.closest('fieldset');
  const legend = describe(fieldset?.querySelector('legend')?.textContent);
  if (legend) return legend;
  const container = el.closest(
    'fieldset, section, form, [role="dialog"], [role="alertdialog"], [role="group"]',
  );
  return describe(
    container?.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')?.textContent,
  );
}

function describeCandidate(el: HTMLElement, index: number): PageAssistCandidate {
  const tag = el.tagName.toLowerCase();
  const attributes = describeAttributes(el);
  const placeholder = describe(el.getAttribute('placeholder'));
  // Never read an input's `value`: only labels and visible text are described.
  const visibleText = isFormControl(el) ? '' : describe(el.textContent);
  const name =
    describe(getAccessibleName(el)) ||
    describe(el.getAttribute('title')) ||
    placeholder ||
    visibleText ||
    attributes['data-hook'] ||
    attributes['data-testid'] ||
    '';
  const role = describe(el.getAttribute('role')) || implicitRole(el);
  const type =
    tag === 'input' || tag === 'button'
      ? describe(el.getAttribute('type')?.toLowerCase() ?? '')
      : '';
  const context = nearestContext(el);
  return {
    index,
    tag,
    ...(role ? { role } : {}),
    ...(type ? { type } : {}),
    name,
    ...(visibleText ? { text: visibleText } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(context ? { context } : {}),
    attributes,
    inDialog: isInDialog(el),
    disabled: isDisabledElement(el),
  };
}

function collect(root: ParentNode): HTMLElement[] {
  const elements: HTMLElement[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR))) {
    if (!isVisible(element)) continue;
    elements.push(element);
    if (elements.length >= PAGE_ASSIST_MAX_CANDIDATES) break;
  }
  return elements;
}

function isButtonLike(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return true;
  if ((el.getAttribute('role') ?? '').toLowerCase() === 'button') return true;
  if (tag !== 'input') return false;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  return type === 'button' || type === 'submit';
}

/** The only field shapes a document target may resolve to. */
function isFieldControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') return true;
  if ((el.getAttribute('role') ?? '').toLowerCase() === 'combobox') return true;
  if (tag === 'button' && el.hasAttribute('aria-haspopup')) return true;
  if (tag !== 'input') return false;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  return type === 'text' || type === 'search';
}

function hasBlockedText(el: Element): boolean {
  return BLOCKED_BUTTON_TEXT.test(`${getAccessibleName(el)} ${el.textContent ?? ''}`);
}

/**
 * Deterministic rules the model's answer must still pass. The model may only
 * choose which control; it cannot relax any of these checks.
 */
function isSafeCandidate(el: HTMLElement, target: PageAssistTarget, doc: Document): boolean {
  if (el.ownerDocument !== doc) return false;
  if (!el.isConnected || !isVisible(el)) return false;
  if (isDisabledElement(el)) return false;
  const inDialog = isInDialog(el);
  switch (target) {
    case 'applyButton':
      return !inDialog && isButtonLike(el) && !hasBlockedText(el);
    case 'submitButton':
      return inDialog && isButtonLike(el) && !hasBlockedText(el);
    default:
      if (!inDialog || !isFieldControl(el)) return false;
      // A field resolved to a picker button must not be a destructive action.
      return !(isButtonLike(el) && hasBlockedText(el));
  }
}

/**
 * Last-resort lookup for a control the deterministic selectors missed. Returns
 * an element only when it passes the target's safety rules; null otherwise.
 * Callers must still run their normal post-click / pre-submit verification.
 */
export async function assistLocate(
  doc: Document,
  target: PageAssistTarget,
  options: PageAssistOptions,
): Promise<HTMLElement | null> {
  try {
    if (options.signal?.aborted) return null;
    const pageAssist = options.control?.pageAssist;
    if (!pageAssist) return null;
    const elements = collect(options.root);
    if (elements.length === 0) return null;
    const candidates = elements.map((element, index) => describeCandidate(element, index));
    if (options.signal?.aborted) return null;
    const answer = await pageAssist({ target, scope: options.scope, candidates });
    if (!answer || options.signal?.aborted) return null;
    const index = answer.index;
    if (index === null || !Number.isInteger(index) || index < 0 || index >= elements.length)
      return null;
    const picked = elements[index];
    if (!picked || !isSafeCandidate(picked, target, doc)) return null;
    return picked;
  } catch {
    return null;
  }
}
