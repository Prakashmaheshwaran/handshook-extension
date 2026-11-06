/**
 * Apply-path classification from DOM labels and API settings. Read-only: this
 * module never clicks or submits anything.
 */

import type { ApplyType } from '@/core/contracts';
import { safeExternalUrl } from '@/core/util/application-policy';
import { isDisabledElement, isVisible } from './dom';
import { isHandshakeUrl } from './host';
import { getAccessibleName, normalizeText } from './text';

const ACTION_SELECTOR = 'button, a, [role="button"], [role="link"]';

const EXTERNAL_COPY =
  /^(apply externally|apply external|external application|apply on (the )?(company|employer)s? (site|website))$/;
const QUICK_COPY = /\bquick apply\b/;
const APPLY_COPY = /^(apply|apply now|apply to job|apply for this job)$/;

/** Read a visible employer Apply link without following it or changing the runner URL. */
export function externalApplyUrl(root: Document | Element): string | undefined {
  for (const el of Array.from(root.querySelectorAll('a[href]'))) {
    if (
      !isVisible(el) ||
      isDisabledElement(el) ||
      !normalizeText(getAccessibleName(el)).includes('apply')
    )
      continue;
    const href = el.getAttribute('href');
    if (!href) continue;
    const safe = safeExternalUrl(href.startsWith('//') ? `https:${href}` : href);
    if (safe) return safe;
  }
  return undefined;
}

/**
 * Classify the application path from visible action labels. External wins over
 * quick apply, which wins over a plain Apply button.
 */
export function classifyApplyType(doc: Document | Element): ApplyType {
  if (externalApplyUrl(doc)) return 'external';
  let sawQuickApply = false;
  let sawHandshakeApply = false;

  for (const el of Array.from(doc.querySelectorAll(ACTION_SELECTOR))) {
    if (!isVisible(el) || isDisabledElement(el)) continue;
    const name = normalizeText(getAccessibleName(el));
    if (name.length === 0) continue;

    const href = el.getAttribute('href');
    if (href && /^https?:/i.test(href) && !isHandshakeUrl(href) && name.includes('apply')) {
      return 'external';
    }
    if (EXTERNAL_COPY.test(name)) return 'external';
    if (QUICK_COPY.test(name)) {
      sawQuickApply = true;
      continue;
    }
    if (APPLY_COPY.test(name)) sawHandshakeApply = true;
  }

  if (sawQuickApply) return 'quick_apply';
  if (sawHandshakeApply) return 'handshake_form';
  return 'unknown';
}

/** Cards can label an external path without rendering its Apply control yet. */
export function classifyCardApplyType(card: Element): ApplyType {
  const actionType = classifyApplyType(card);
  if (actionType === 'external') return actionType;
  for (const label of Array.from(card.querySelectorAll('span, p, small, [aria-label]'))) {
    if (!isVisible(label)) continue;
    const text = normalizeText(getAccessibleName(label));
    if (EXTERNAL_COPY.test(text)) return 'external';
  }
  return actionType;
}

/** Map `job_apply_setting.apply_type` to the contract enum. */
export function mapApplyTypeSetting(value: unknown): ApplyType {
  if (typeof value !== 'string') return 'unknown';
  const normalized = normalizeText(value);
  if (normalized === 'handshake' || normalized === 'handshake form' || normalized === 'internal') {
    return 'handshake_form';
  }
  if (normalized === 'quick apply' || normalized === 'quick' || normalized === 'quick apply form') {
    return 'quick_apply';
  }
  if (
    normalized === 'external' ||
    normalized === 'external apply' ||
    normalized === 'company site'
  ) {
    return 'external';
  }
  return 'unknown';
}
