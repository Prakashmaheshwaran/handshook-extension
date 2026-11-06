import type { DelayRange, DocumentRecord, DocumentSelection, DocumentType } from '@/core/contracts';
import type { PageAssistTarget } from '@/core/contracts/pageAssist';
import type { ApplyControl } from '@/core/contracts/submitAuthorization';
import { assistLocate } from '@/handshake/page-assist';
import { humanDelay } from './human-delay';
import {
  DOCUMENT_TYPES,
  documentChoiceError,
  documentLabel,
  findDocumentForType,
  idForType,
  quickApplyMayUseUnselectedDocument,
  resolveRequiredDocumentTypes,
} from '@/core/documents/selection';
import {
  clickElement,
  getAccessibleName,
  isDisabledElement,
  isVisible,
  openCombobox,
  selectNative,
  setNativeValue,
  throwIfAborted,
  waitFor,
  WaitTimeoutError,
} from '@/handshake/dom';
import { collapseWhitespace, normalizeText } from '@/handshake/text';

export {
  findDocumentForType,
  findMissingDocumentTypes,
  resolveRequiredDocumentTypes,
} from '@/core/documents/selection';

// Handshake's pickers are labelled in the plural ("Search your resumes"), so
// each pattern accepts both forms.
const FIELD_PATTERNS: Record<DocumentType, RegExp> = {
  resume: /\bresumes?\b|\bcvs?\b/i,
  cover_letter: /\bcover\s*letters?\b/i,
  transcript: /\btranscripts?\b/i,
  other:
    /\b(?:other|additional)\s*(?:(?:required|optional)\s+)?(?:documents?|files?)\b|\bsupporting\s*(?:(?:required|optional)\s+)?documents?\b/i,
};

/** Page-assist target for each document field, used only when selectors miss. */
const FIELD_TARGETS: Record<DocumentType, PageAssistTarget> = {
  resume: 'resumeField',
  cover_letter: 'coverLetterField',
  transcript: 'transcriptField',
  other: 'otherDocumentField',
};

/** Path segments that precede a document ID inside a document link. */
const DOCUMENT_PATH = /\/(?:docs|documents)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i;

/**
 * Elements that can wrap an already-selected document card. Covers the live
 * "check icon + file name + Preview document + ×" shape without depending on
 * one vendor class name.
 */
const CARD_SELECTOR = [
  '[data-testid*="document" i]',
  '[data-testid*="file" i]',
  '[data-testid*="attachment" i]',
  '[class*="document" i]',
  '[class*="file" i]',
  '[class*="attachment" i]',
  '[class*="card" i]',
  'li',
].join(',');

/** An open picker's options are choices, never a selected card. */
const OPTION_CONTAINER =
  '[role="option"], [role="listbox"], [role="menu"], [data-testid*="option" i]';

interface FieldHandle {
  control: Element;
  container: Element;
  label: string;
  /** Present when the field currently renders an already-selected card. */
  card?: Element;
}

interface LocatedField {
  field: FieldHandle;
  /** The element page assist found, kept for synchronous re-verification. */
  assisted: Element | null;
}

function dialogRoot(doc: Document): Element {
  const dialogs = Array.from(
    doc.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]'),
  );
  return dialogs.find((dialog) => isVisible(dialog)) ?? doc.body;
}

/** The site's explicit empty-form declaration, never inferred from a missing picker. */
export function formDeclaresNoDocuments(doc: Document): boolean {
  const root = dialogRoot(doc);
  if (root === doc.body) return false;
  const declaration = Array.from(root.querySelectorAll('p')).some(
    (paragraph) =>
      isVisible(paragraph) &&
      /^applying requires no additional documents[.!]?$/.test(
        normalizeText(paragraph.textContent ?? ''),
      ),
  );
  return (
    declaration &&
    !DOCUMENT_TYPES.some((type) => findField(doc, type) || findSelectedCard(doc, type))
  );
}

function pathDocumentId(href: string): string | null {
  return href.match(DOCUMENT_PATH)?.[1] ?? null;
}

function findField(doc: Document, type: DocumentType): FieldHandle | null {
  const pattern = FIELD_PATTERNS[type];
  const root =
    Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"]')).find(isVisible) ??
    doc.body;
  if (!root) return null;

  const labels = Array.from(root.querySelectorAll('label, legend, [aria-label]'));
  for (const candidate of labels) {
    if (!isVisible(candidate)) continue;
    const text = normalizeText(candidate.getAttribute('aria-label') ?? candidate.textContent ?? '');
    if (!text || text.length > 160 || !pattern.test(text)) continue;

    if (candidate.matches('input, select, [role="combobox"], button[aria-haspopup]')) {
      return {
        control: candidate,
        container: candidate.closest('div, fieldset, section') ?? root,
        label: text,
      };
    }

    if (candidate.tagName === 'LABEL') {
      const htmlFor = candidate.getAttribute('for');
      if (htmlFor) {
        const byId = root.ownerDocument.getElementById(htmlFor);
        if (byId && isVisible(byId)) {
          return {
            control: byId,
            container:
              candidate.closest('fieldset, section, div') ?? candidate.parentElement ?? root,
            label: text,
          };
        }
      }
    }

    const container =
      candidate.closest('fieldset, section, [role="group"], div') ?? candidate.parentElement;
    if (!container) continue;
    const control = Array.from(
      container.querySelectorAll(
        'input, select, textarea, [role="combobox"], button[aria-haspopup]',
      ),
    ).find((el) => isVisible(el) && !/hidden/i.test(el.getAttribute('type') ?? ''));
    if (control) return { control, container, label: text };
  }

  const inputs = Array.from(
    root.querySelectorAll<HTMLElement>(
      'input[placeholder], [role="combobox"], select, button[aria-haspopup]',
    ),
  );
  for (const control of inputs) {
    const label = normalizeText(
      `${getAccessibleName(control)} ${control.getAttribute('placeholder') ?? ''} ${control.getAttribute('name') ?? ''}`,
    );
    if (isVisible(control) && pattern.test(label)) {
      return { control, container: control.closest('div, fieldset, section') ?? root, label };
    }
  }
  return null;
}

/**
 * Regions that carry a document field's label or heading ("Attach your
 * resume"). The live dialog labels each attachment section rather than using a
 * `<label for>`, so the card shape is found through its section.
 */
function fieldRegions(doc: Document, type: DocumentType): Element[] {
  const pattern = FIELD_PATTERNS[type];
  const root = dialogRoot(doc);
  const regions: Element[] = [];
  const candidates = Array.from(
    root.querySelectorAll('label, legend, [aria-label], h2, h3, h4, [role="group"]'),
  );
  for (const candidate of candidates) {
    if (!isVisible(candidate)) continue;
    const text = normalizeText(candidate.getAttribute('aria-label') ?? candidate.textContent ?? '');
    if (!text || text.length > 160 || !pattern.test(text)) continue;
    // Prefer the semantic container: live Handshake puts "Attach your resume" in
    // its own <div> and the attached file in a sibling alert beside it, both
    // inside one <fieldset>. Stopping at the nearest <div> would leave a region
    // holding only the heading, so the card would never be found.
    const region =
      candidate.closest('fieldset, section, [role="group"]') ?? candidate.closest('li, div');
    if (region && !regions.includes(region)) regions.push(region);
  }
  return regions;
}

/** The document ID any link or allow-listed attribute inside a card exposes. */
function cardDocumentId(card: Element): string | null {
  for (const node of [card, ...Array.from(card.querySelectorAll('*'))]) {
    for (const attribute of ['data-document-id', 'data-id', 'value']) {
      const value = node.getAttribute(attribute)?.trim();
      if (value) return value;
    }
  }
  const links = [card, ...Array.from(card.querySelectorAll('a[href]'))].filter((node) =>
    node.matches('a[href]'),
  );
  for (const link of links) {
    const id = pathDocumentId(link.getAttribute('href') ?? '');
    if (id) return id;
  }
  return null;
}

/**
 * The file title shown on a selected card: its text with the remove button,
 * preview link and decorative icon removed. Empty when the card shows no title.
 */
function cardTitle(card: Element): string {
  const clone = card.cloneNode(true) as Element;
  for (const action of Array.from(
    clone.querySelectorAll('a, button, svg, [role="button"], [aria-hidden="true"]'),
  )) {
    action.remove();
  }
  return normalizeText(clone.textContent ?? '');
}

function removeCopy(element: Element): boolean {
  const raw = collapseWhitespace(getAccessibleName(element) || element.textContent || '');
  return /^(?:×|✕|x|remove|delete|clear)$/i.test(raw) || /\bremove\b/i.test(raw);
}

/** Copy on a status alert's dismiss control, which detaches the attached file. */
const ALERT_DISMISS = /^(?:close|dismiss)$/i;

function cardRemoveButton(card: Element): HTMLElement | null {
  // Live Handshake renders the attached resume as a dismissible status alert:
  // the "×" is the alert's own labelled "Close" button, a sibling of the file
  // text rather than a child of the card the text lives in.
  const alert = card.closest('.rosetta-inline-alert, [role="status"]');
  const scope = alert ?? card;
  const buttons = Array.from(
    scope.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"]'),
  );
  return (
    buttons.find(
      (button) =>
        isVisible(button) &&
        !isDisabledElement(button) &&
        (removeCopy(button) ||
          (alert !== null &&
            ALERT_DISMISS.test(
              collapseWhitespace(getAccessibleName(button) || button.textContent || ''),
            ))),
    ) ?? null
  );
}

/**
 * The already-selected card shown in a document field. A card is identified by
 * a document link/attribute (with or without a remove control) or by a remove
 * control next to a file title. Options of an open picker are never cards.
 */
/**
 * Wait for a picker to offer the option a predicate accepts. Live Handshake
 * lists ~200 resumes in a virtualised listbox: the list is visible before the
 * search filter has applied, so the matching row may only render a moment
 * later. Reading once would miss it and fall back to the wrong document.
 */
async function waitForOption(
  doc: Document,
  field: FieldHandle,
  pick: (list: Element) => Element | undefined,
  signal?: AbortSignal,
  timeoutMs = 4_000,
): Promise<Element | undefined> {
  try {
    return await waitFor(
      () => {
        const list = visibleOptionList(doc, field);
        return list ? (pick(list) ?? null) : null;
      },
      { timeoutMs, signal },
    );
  } catch (error) {
    if (error instanceof WaitTimeoutError) return undefined;
    throw error;
  }
}

/** The picker's first row: the account's own default for that slot. */
function firstOption(list: Element): Element | undefined {
  return Array.from(
    list.querySelectorAll('[role="option"], option, li, [data-value], [data-document-id]'),
  ).find((entry) => isVisible(entry) && !isDisabledElement(entry));
}

/** Wait until a picked document shows as an attached card again. */
async function waitForCard(
  doc: Document,
  type: DocumentType,
  signal?: AbortSignal,
): Promise<HTMLElement | null> {
  try {
    const card = await waitFor(() => findSelectedCard(doc, type), { timeoutMs: 3_000, signal });
    return card instanceof HTMLElement ? card : null;
  } catch (error) {
    if (error instanceof WaitTimeoutError) return null;
    throw error;
  }
}

/** The one option whose visible text is exactly this file name. */
function optionByTitle(list: Element, title: string): Element | undefined {
  const want = normalizeText(title);
  if (!want) return undefined;
  const matches = Array.from(
    list.querySelectorAll('[role="option"], option, li, [data-value], [data-document-id]'),
  ).filter(
    (entry) =>
      isVisible(entry) &&
      !isDisabledElement(entry) &&
      normalizeText(entry.textContent ?? '') === want,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function findSelectedCard(doc: Document, type: DocumentType): HTMLElement | null {
  for (const region of fieldRegions(doc, type)) {
    const references = Array.from(
      region.querySelectorAll('[data-document-id], [data-id], a[href]'),
    );
    for (const reference of references) {
      if (!isVisible(reference) || reference.closest(OPTION_CONTAINER)) continue;
      const hasId =
        reference.hasAttribute('data-document-id') ||
        reference.hasAttribute('data-id') ||
        pathDocumentId(reference.getAttribute('href') ?? '') !== null;
      if (!hasId) continue;
      const card = reference.closest(CARD_SELECTOR) ?? reference.parentElement;
      if (card instanceof HTMLElement && isVisible(card) && region.contains(card)) return card;
    }
    const remove = cardRemoveButton(region);
    const card = remove?.closest(CARD_SELECTOR) ?? remove?.parentElement;
    if (card instanceof HTMLElement && isVisible(card) && cardTitle(card)) return card;
  }
  return null;
}

function cardHandle(card: Element, type: DocumentType): FieldHandle {
  return { control: card, container: card, label: type.replace('_', ' '), card };
}

function controlHandle(control: Element): FieldHandle {
  return {
    control,
    container: control.closest('div, fieldset, section') ?? control.ownerDocument.body,
    label: getAccessibleName(control),
  };
}

function optionId(option: Element): string | null {
  const attribute =
    option.getAttribute('data-document-id') ??
    option.getAttribute('data-value') ??
    option.getAttribute('data-id') ??
    option.getAttribute('value');
  if (attribute) return attribute;
  // An option may expose the document only through a `/docs/<id>` link.
  const links = [option, ...Array.from(option.querySelectorAll('a[href]'))].filter((node) =>
    node.matches('a[href]'),
  );
  for (const link of links) {
    const id = pathDocumentId(link.getAttribute('href') ?? '');
    if (id) return id;
  }
  return null;
}

/** A title match is only safe when the user typed a name and it is unique. */
function uniqueTitle(document: DocumentRecord, available: readonly DocumentRecord[]): boolean {
  const title = normalizeText(document.title);
  if (!title) return false;
  return available.filter((entry) => normalizeText(entry.title) === title).length === 1;
}

/** Only the selected value/trigger is evidence; listbox text includes unselected files. */
function fieldHasDocument(
  field: FieldHandle,
  document: DocumentRecord,
  allowTitle: boolean,
): boolean {
  if (field.card) {
    const cardId = cardDocumentId(field.card);
    if (cardId !== null) return cardId === document.id;
    // With no readable ID the only safe evidence is the user's own name for the
    // file. A blank name never proves anything.
    const name = normalizeText(document.title);
    return name.length > 0 && cardTitle(field.card) === name;
  }
  const control = field.control;
  if (control.tagName === 'SELECT') {
    const selected = (control as HTMLSelectElement).selectedOptions;
    return selected.length === 1 && selected[0]?.value === document.id;
  }
  const selectedId = optionId(control);
  if (selectedId !== null) return selectedId === document.id;
  // Search pickers often commit the chosen ID to a named hidden backing
  // control. Scope it to this field and type, never to arbitrary option text.
  const backing = Array.from(
    field.container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input[type="hidden"][name], select[name]',
    ),
  ).filter((entry) => FIELD_PATTERNS[document.type].test(entry.name.replace(/[_-]/g, ' ')));
  if (backing.length > 0) return backing.length === 1 && backing[0]?.value === document.id;
  // The search query we just typed is not proof that an option was selected.
  if (control.tagName === 'INPUT') return false;
  return allowTitle && normalizeText(control.textContent ?? '') === normalizeText(document.title);
}

/** True when a field already shows a selected file (used for unconfigured types). */
function hasSelectedDocument(
  field: FieldHandle,
  type: DocumentType,
  available: readonly DocumentRecord[],
): boolean {
  if (field.card) return cardDocumentId(field.card) !== null || cardTitle(field.card).length > 0;
  const control = field.control;
  if (control.tagName === 'SELECT') {
    return Array.from((control as HTMLSelectElement).selectedOptions).some(
      (option) => option.value !== '',
    );
  }
  if (optionId(control)) return true;
  const hasBackingSelection = Array.from(
    field.container.querySelectorAll<HTMLInputElement>('input[type="hidden"][name]'),
  ).some(
    (input) => FIELD_PATTERNS[type].test(input.name.replace(/[_-]/g, ' ')) && input.value !== '',
  );
  if (hasBackingSelection) return true;
  const controlText = normalizeText(control.textContent ?? '');
  // An empty label is not evidence of a selection, and never matches a record
  // the user left unnamed.
  return (
    controlText.length > 0 &&
    available.some(
      (document) =>
        document.type === type &&
        normalizeText(document.title).length > 0 &&
        normalizeText(document.title) === controlText,
    )
  );
}

/** The open option list for a field. A dialog can hold several pickers at once. */
function visibleOptionList(doc: Document, field: FieldHandle): Element | null {
  const selector = '[role="listbox"], [role="menu"], [data-testid*="listbox" i]';
  const scoped = Array.from(field.container.querySelectorAll(selector)).find((list) =>
    isVisible(list),
  );
  if (scoped) return scoped;
  return Array.from(doc.querySelectorAll(selector)).find((list) => isVisible(list)) ?? null;
}

function exactOption(
  list: Element,
  document: DocumentRecord,
  allowTitle: boolean,
): Element | undefined {
  const candidates = Array.from(
    list.querySelectorAll('[role="option"], option, li, [data-value], [data-document-id]'),
  ).filter((entry) => isVisible(entry) && !isDisabledElement(entry));
  const byId = candidates.filter((entry) => optionId(entry) === document.id);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1 || !allowTitle) return undefined;
  const want = normalizeText(document.title);
  const titled = candidates.filter((entry) => optionId(entry) === null);
  const byTitle = titled.filter((entry) => normalizeText(entry.textContent ?? '') === want);
  if (byTitle.length === 1) return byTitle[0];
  if (!want) return undefined;
  // A file can be offered under a slightly different spelling than the name the
  // user typed (extra words, truncation, a hyphen), so fall back to a unique
  // prefix match and then to a unique "contains every word" match.
  const starts = titled.filter((entry) => {
    const text = normalizeText(entry.textContent ?? '');
    return text.length > 0 && (text.startsWith(want) || want.startsWith(text));
  });
  if (starts.length === 1) return starts[0];
  const tokens = want.split(' ').filter(Boolean);
  if (tokens.length < 2) return undefined;
  const contains = titled.filter((entry) => {
    const words = new Set(normalizeText(entry.textContent ?? '').split(' '));
    return tokens.every((token) => words.has(token));
  });
  return contains.length === 1 ? contains[0] : undefined;
}

/** Card first, then a selector-found control, then an element page assist located. */
function resolveFieldForVerification(
  doc: Document,
  type: DocumentType,
  assisted: Element | undefined,
): FieldHandle | null {
  const card = findSelectedCard(doc, type);
  if (card) return cardHandle(card, type);
  const field = findField(doc, type);
  if (field) return field;
  return assisted && isVisible(assisted) ? controlHandle(assisted) : null;
}

export interface DocumentSelectionResult {
  ok: boolean;
  used: { type: DocumentType; id: string }[];
  missing: DocumentType[];
  errors: string[];
  /** The located control per selected type, for synchronous re-verification. */
  fields?: Partial<Record<DocumentType, HTMLElement>>;
}

/** Recheck the actual selected files after every asynchronous pre-submit step. */
export function verifySelectedDocuments(
  doc: Document,
  used: DocumentSelectionResult['used'],
  available: readonly DocumentRecord[],
  fields: DocumentSelectionResult['fields'] = {},
): DocumentSelectionResult {
  const missing: DocumentType[] = [];
  const errors: string[] = [];
  for (const selected of used) {
    const record = available.find(
      (entry) => entry.id === selected.id && entry.type === selected.type,
    );
    const field = resolveFieldForVerification(doc, selected.type, fields?.[selected.type]);
    // A file the form attached itself (Handshake's account default) has no
    // configured record, so trust the card's own document ID for it.
    const shownId = field?.card ? cardDocumentId(field.card) : null;
    const verified = field
      ? shownId !== null
        ? shownId === selected.id
        : record !== undefined && fieldHasDocument(field, record, uniqueTitle(record, available))
      : false;
    if (!verified) {
      missing.push(selected.type);
      errors.push(
        `The chosen ${selected.type.replace('_', ' ')} changed. Select it again before submitting.`,
      );
    }
  }
  for (const type of DOCUMENT_TYPES) {
    if (used.some((selected) => selected.type === type)) continue;
    const field = resolveFieldForVerification(doc, type, fields?.[type]);
    if (!field) continue;
    if (hasSelectedDocument(field, type, available)) {
      missing.push(type);
      errors.push(
        `An unconfigured ${type.replace('_', ' ')} is selected. Review the attachments before submitting.`,
      );
    }
  }
  return { ok: errors.length === 0, used: errors.length === 0 ? used : [], missing, errors };
}

/**
 * Legacy document preflight, used to describe missing files during a manual
 * handoff. It does not authorize a one-click send or prove Handshake's defaults;
 * the informed one-click policy records profile defaults instead of these IDs.
 */
export function verifyQuickApplyDocuments(
  doc: Document,
  required: DocumentType[],
  selection: DocumentSelection,
  available: DocumentRecord[],
): DocumentSelectionResult {
  const used: DocumentSelectionResult['used'] = [];
  const missing: DocumentType[] = [];
  const errors: string[] = [];
  const requiredTypes = resolveRequiredDocumentTypes(required);
  for (const type of DOCUMENT_TYPES) {
    const field = findField(doc, type);
    const wanted = requiredTypes.includes(type) || Boolean(idForType(selection, type));
    if (!wanted) {
      if (field) errors.push(`Quick Apply has an unconfigured ${type.replace('_', ' ')} picker`);
      continue;
    }
    const chosen = findDocumentForType(selection, type, available);
    if (!chosen) {
      missing.push(type);
      errors.push(documentChoiceError(selection, type, available) ?? `Missing ${type}`);
      continue;
    }
    const verified = field
      ? fieldHasDocument(field, chosen, uniqueTitle(chosen, available))
      : quickApplyMayUseUnselectedDocument(type, requiredTypes, available);
    if (verified) used.push({ type, id: chosen.id });
    else
      errors.push(
        `Cannot verify Quick Apply will send chosen ${type.replace('_', ' ')} (${documentLabel(chosen)})`,
      );
  }
  return { ok: errors.length === 0, used, missing, errors };
}

/**
 * Locate a document field: an already-selected card, then the deterministic
 * selector, then a last-resort page-assist lookup inside the open dialog.
 *
 * `allowAssist` is false for the optional attachments below: the deterministic
 * scan already answered whether the open form renders that slot, so asking the
 * model to look for a slot the form does not offer would spend a paid request
 * on every job. A required document keeps the assist fallback because a missed
 * required field must never be guessed or silently skipped.
 */
async function locateField(
  doc: Document,
  type: DocumentType,
  control?: ApplyControl,
  signal?: AbortSignal,
  allowAssist = true,
): Promise<LocatedField | null> {
  const card = findSelectedCard(doc, type);
  if (card) return { field: cardHandle(card, type), assisted: null };
  const field = findField(doc, type);
  if (field) return { field, assisted: null };
  if (!allowAssist) return null;
  const assisted = await assistLocate(doc, FIELD_TARGETS[type], {
    root: fieldRegions(doc, type)[0] ?? dialogRoot(doc),
    scope: 'dialog',
    control,
    signal,
  });
  if (!assisted || !isVisible(assisted)) return null;
  return { field: controlHandle(assisted), assisted };
}

function elementOf(field: FieldHandle): HTMLElement | undefined {
  return field.control instanceof HTMLElement ? field.control : undefined;
}

/**
 * Puts back the file the application attached itself after the user's choice
 * could not be found in the picker. Handshake's account default resume is the
 * user's own document; applying with it beats parking the job on a name that
 * does not match any file in the account.
 */
async function restoreAttached(
  doc: Document,
  type: DocumentType,
  input: HTMLInputElement,
  field: FieldHandle,
  title: string,
  signal?: AbortSignal,
  delay?: DelayRange,
): Promise<{ ok: boolean; field?: HTMLElement; usedDocumentId?: string } | null> {
  if (!title) return null;
  clickElement(input);
  setNativeValue(input, title);
  const option = await waitForOption(doc, field, (list) => optionByTitle(list, title), signal);
  await humanDelay(delay, signal);
  if (!option || !clickElement(option)) return null;
  let card: Element | null;
  try {
    card = await waitFor(() => findSelectedCard(doc, type), { timeoutMs: 3_000, signal });
  } catch (error) {
    if (!(error instanceof WaitTimeoutError)) throw error;
    return null;
  }
  const id = card ? cardDocumentId(card) : null;
  return {
    ok: true,
    ...(card instanceof HTMLElement ? { field: card } : {}),
    ...(id ? { usedDocumentId: id } : {}),
  };
}

export async function selectDocument(
  doc: Document,
  type: DocumentType,
  document: DocumentRecord,
  signal?: AbortSignal,
  available: readonly DocumentRecord[] = [document],
  delay?: DelayRange,
  control?: ApplyControl,
  located?: LocatedField | null,
): Promise<{
  ok: boolean;
  error?: string;
  field?: HTMLElement;
  /** The attached file's own ID when the form would not let it be replaced. */
  usedDocumentId?: string;
}> {
  throwIfAborted(signal);
  if (document.type !== type) {
    return {
      ok: false,
      error: `Chosen ${type.replace('_', ' ')} (${documentLabel(document)}) has type ${document.type.replace('_', ' ')}`,
    };
  }
  let current = located === undefined ? await locateField(doc, type, control, signal) : located;
  if (!current) return { ok: false, error: `${type} field not found` };

  const allowTitle = uniqueTitle(document, available);
  const typeLabel = type.replace('_', ' ');
  // Title of the file the form attached itself, kept so it can be put back if
  // the user's document is not offered after the attachment is dismissed.
  let restoreTitle = '';
  if (current.field.card) {
    if (fieldHasDocument(current.field, document, allowTitle))
      return { ok: true, ...(elementOf(current.field) ? { field: elementOf(current.field) } : {}) };
    // The dialog preselected a different file (or one we cannot name): remove
    // it, then choose the user's document through the revealed picker. The
    // title is kept so the form's own choice can be restored when the user's
    // document is not in the picker.
    const attached = current.field.card;
    restoreTitle = cardTitle(attached);
    const remove = cardRemoveButton(attached);
    // Handshake's Quick apply dialog shows the account's default resume as a
    // read-only status alert: no remove or change control exists. Blocking
    // would park every such job with nothing the user could do, so the attached
    // file is accepted and its own ID reported as used instead. The caller
    // shows that document in Activity rather than claiming the configured one.
    if (!remove || !clickElement(remove)) {
      const attachedId = cardDocumentId(attached);
      return {
        ok: true,
        ...(elementOf(current.field) ? { field: elementOf(current.field) } : {}),
        ...(attachedId ? { usedDocumentId: attachedId } : {}),
      };
    }
    try {
      await waitFor(() => (findSelectedCard(doc, type) === null ? true : null), {
        timeoutMs: 3_000,
        signal,
      });
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
      return { ok: false, error: `The attached ${typeLabel} did not clear` };
    }
    current = await locateField(doc, type, control, signal);
    if (!current || current.field.card) {
      return { ok: false, error: `Could not replace the ${typeLabel} already attached` };
    }
  }

  const assistedControl = current.assisted;
  const field = current.field;
  await humanDelay(delay, signal);
  const controlElement = field.control;
  if (isDisabledElement(controlElement)) return { ok: false, error: `${type} field is disabled` };
  const tag = controlElement.tagName.toLowerCase();
  // Send the user's own name for the file when they gave one; comparisons stay
  // normalized. An unnamed record opens the picker without typing.
  const matcher = document.title.trim();
  const missing = () => ({
    ok: false,
    error: `Your ${typeLabel} (${documentLabel(document)}) is not offered in this application's picker`,
  });
  const verify = async () => {
    let matched: HTMLElement | undefined;
    const currentField = (): FieldHandle | null => {
      const card = findSelectedCard(doc, type);
      const handle =
        card !== null
          ? cardHandle(card, type)
          : (findField(doc, type) ??
            (assistedControl && isVisible(assistedControl)
              ? controlHandle(assistedControl)
              : null));
      if (handle && handle.control instanceof HTMLElement) matched = handle.control;
      return handle;
    };
    try {
      await waitFor(
        () => {
          const handle = currentField();
          return handle && fieldHasDocument(handle, document, allowTitle) ? true : null;
        },
        { timeoutMs: 2_000, signal },
      );
      return { ok: true, ...(matched ? { field: matched } : {}) };
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
      return {
        ok: false,
        error: `Could not verify chosen ${typeLabel} (${documentLabel(document)})`,
      };
    }
  };

  if (tag === 'select') {
    const select = controlElement as HTMLSelectElement;
    const findOption = () =>
      Array.from(select.options).find((opt) => !opt.disabled && opt.value === document.id) ?? null;
    let option = findOption();
    if (!option) {
      try {
        option = await waitFor(() => findOption(), { timeoutMs: 5_000, signal });
      } catch (error) {
        if (!(error instanceof WaitTimeoutError)) throw error;
        option = null;
      }
    }
    if (option && option.value !== '' && selectNative(select, option.value)) {
      return verify();
    }
    return missing();
  }

  if (tag === 'input') {
    const input = controlElement as HTMLInputElement;
    if (/search/i.test(input.getAttribute('placeholder') ?? '') || input.type === 'text') {
      if (matcher) {
        clickElement(input);
        setNativeValue(input, matcher);
      } else {
        // An unnamed record has no search text to type; focus/click to open the
        // picker and let the ID-only match below decide.
        input.focus();
        clickElement(input);
      }
      try {
        await waitFor(() => visibleOptionList(doc, field), { timeoutMs: 3_000, signal });
      } catch (error) {
        if (error instanceof WaitTimeoutError) {
          // The field may be a plain text input rather than a picker.
        } else {
          throw error;
        }
      }
      // A slot the user did not name (a cover letter or transcript added by ID
      // only) has no text to search for. The picker's first row is the account's
      // own default for that slot, which the user has chosen to rely on.
      // Options that expose a document ID are matched first even without a
      // name; only a picker that shows bare titles falls back to its first row.
      const target = matcher
        ? await waitForOption(doc, field, (list) => exactOption(list, document, allowTitle), signal)
        : ((await waitForOption(
            doc,
            field,
            (list) => exactOption(list, document, false),
            signal,
            1_200,
          )) ?? (await waitForOption(doc, field, firstOption, signal, 1_000)));
      await humanDelay(delay, signal);
      if (target && clickElement(target)) {
        if (matcher) return verify();
        const picked = await waitForCard(doc, type, signal);
        const id = picked ? cardDocumentId(picked) : null;
        if (picked) {
          return { ok: true, field: picked, ...(id ? { usedDocumentId: id } : {}) };
        }
        return { ok: false, error: `Could not verify chosen ${typeLabel}` };
      }
      const restored = restoreTitle
        ? await restoreAttached(doc, type, input, field, restoreTitle, signal, delay)
        : null;
      if (restored) return restored;
      // The saved name is not a file in this account (a renamed or mistyped
      // label). Clear the filter and take the account's own default rather than
      // stopping the application; the ID actually attached is reported.
      setNativeValue(input, '');
      const fallback = await waitForOption(doc, field, firstOption, signal, 1_500);
      await humanDelay(delay, signal);
      if (fallback && clickElement(fallback)) {
        const picked = await waitForCard(doc, type, signal);
        const pickedId = picked ? cardDocumentId(picked) : null;
        if (picked) {
          return { ok: true, field: picked, ...(pickedId ? { usedDocumentId: pickedId } : {}) };
        }
      }
    }
    return { ok: false, error: `Could not select ${type} via search input` };
  }

  if (
    controlElement.getAttribute('role') === 'combobox' ||
    controlElement.hasAttribute('aria-haspopup')
  ) {
    const list = await openCombobox(controlElement, { timeoutMs: 3_000, signal });
    if (!list) return { ok: false, error: `Could not open ${type} picker` };
    const target = exactOption(list, document, allowTitle);
    await humanDelay(delay, signal);
    if (target && clickElement(target)) return verify();
    return missing();
  }

  return { ok: false, error: `Unsupported ${type} field` };
}

export async function selectRequiredDocuments(
  doc: Document,
  required: DocumentType[],
  selection: DocumentSelection,
  available: DocumentRecord[],
  signal?: AbortSignal,
  delay?: DelayRange,
  control?: ApplyControl,
): Promise<DocumentSelectionResult> {
  const used: { type: DocumentType; id: string }[] = [];
  const missing: DocumentType[] = [];
  const errors: string[] = [];
  const fields: Partial<Record<DocumentType, HTMLElement>> = {};
  // Empty posting metadata normally retains the conservative resume fallback.
  // A visible dialog can explicitly confirm that it offers no attachments.
  const types =
    required.length === 0 && formDeclaresNoDocuments(doc)
      ? []
      : resolveRequiredDocumentTypes(required);

  for (const type of types) {
    const document = findDocumentForType(selection, type, available);
    if (!document) {
      missing.push(type);
      errors.push(documentChoiceError(selection, type, available) ?? `Missing ${type}`);
      continue;
    }
    const result = await selectDocument(doc, type, document, signal, available, delay, control);
    if (result.ok) {
      used.push({ type, id: result.usedDocumentId ?? document.id });
      if (result.field) fields[type] = result.field;
    } else {
      errors.push(result.error ?? `Could not select ${type}`);
      missing.push(type);
    }
  }
  return { ok: missing.length === 0, used, missing, errors, fields };
}

/**
 * M15: the user configured a cover letter/transcript/other document, so attach
 * it whenever the form actually offers that field — even if the posting does
 * not mark it required. Absent fields are ignored, but failed choices must be
 * surfaced for human review; only verified documents are returned as used.
 */
export async function selectConfiguredDocuments(
  doc: Document,
  selection: DocumentSelection,
  available: DocumentRecord[],
  skip: readonly DocumentType[],
  signal?: AbortSignal,
  delay?: DelayRange,
  control?: ApplyControl,
): Promise<DocumentSelectionResult> {
  const used: { type: DocumentType; id: string }[] = [];
  const errors: string[] = [];
  const missing: DocumentType[] = [];
  const fields: Partial<Record<DocumentType, HTMLElement>> = {};
  const types: DocumentType[] = ['cover_letter', 'transcript', 'other'];

  for (const type of types) {
    if (skip.includes(type)) continue;
    const id = idForType(selection, type);
    if (!id) continue;
    const document = findDocumentForType(selection, type, available);
    if (!document) {
      errors.push(documentChoiceError(selection, type, available) ?? `Missing ${type}`);
      missing.push(type);
      continue;
    }
    // Locate the field deterministically (card, then selector). A form that
    // renders no slot for this optional attachment simply does not offer it;
    // only required documents fall back to a paid page-assist lookup.
    const located = await locateField(doc, type, control, signal, false);
    if (!located) continue;
    const result = await selectDocument(
      doc,
      type,
      document,
      signal,
      available,
      delay,
      control,
      located,
    );
    if (result.ok) {
      used.push({ type, id: result.usedDocumentId ?? document.id });
      if (result.field) fields[type] = result.field;
    } else {
      errors.push(result.error ?? `Could not select ${type}`);
      missing.push(type);
    }
  }
  return { ok: errors.length === 0, used, missing, errors, fields };
}
