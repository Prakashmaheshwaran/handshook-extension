import type {
  DelayRange,
  AnswerMatch,
  AnswerValue,
  QuestionDescriptor,
  QuestionOption,
  QuestionType,
} from '@/core/contracts';
import {
  clickElement,
  getAccessibleName,
  isVisible,
  openCombobox,
  pickOption,
  selectNative,
  setNativeValue,
  waitFor,
} from '@/handshake/dom';
import { normalizeText } from '@/handshake/text';
import { simpleHash } from '@/core/util/hash';
import { humanDelay } from './human-delay';

const DOCUMENT_FIELD = /\bresume\b|\bcv\b|\bcover\s*letter\b|\btranscript\b|\bother\s*document\b/i;
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'file', 'image']);

function scope(doc: Document): ParentNode {
  return (
    Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"]')).find(isVisible) ??
    doc.body
  );
}

function labelFor(control: Element, doc: Document): string {
  const inputType = (control.getAttribute('type') ?? '').toLowerCase();
  // A radio/checkbox option label names the option, not the question.
  if (inputType === 'radio' || inputType === 'checkbox') {
    const legend = control.closest('fieldset')?.querySelector('legend');
    if (legend?.textContent?.trim()) return normalizeText(legend.textContent);
  }
  const id = control.getAttribute('id');
  if (id) {
    const explicit = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (explicit) return normalizeText(explicit.textContent ?? '');
  }
  const labelledBy = control.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((part) => doc.getElementById(part)?.textContent ?? '')
      .join(' ');
    if (text.trim()) return normalizeText(text);
  }
  const aria = control.getAttribute('aria-label');
  if (aria?.trim()) return normalizeText(aria);
  const wrapping = control.closest('label');
  if (wrapping) return normalizeText(wrapping.textContent ?? '');
  const fieldset = control.closest('fieldset');
  const legend = fieldset?.querySelector('legend');
  if (legend?.textContent?.trim()) return normalizeText(legend.textContent);
  const group = control.closest('[role="group"], [data-testid*="question" i], div');
  const heading = group?.querySelector('legend, h3, h4, [role="heading"]');
  if (heading?.textContent?.trim()) return normalizeText(heading.textContent);
  return normalizeText(getAccessibleName(control));
}

function questionType(control: Element): QuestionType {
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
    return 'text';
  }
  return 'unknown';
}

function groupInputs(control: Element, doc: Document): HTMLInputElement[] {
  const type = (control.getAttribute('type') ?? '').toLowerCase();
  if (!['radio', 'checkbox'].includes(type)) return [];
  const name = control.getAttribute('name');
  if (!name) return control instanceof HTMLInputElement ? [control] : [];
  const root = control.closest('fieldset') ?? scope(doc);
  return Array.from(
    root.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(name)}"]`),
  ).filter((input) => input.type === type && !input.disabled && isVisible(input));
}

function optionsFor(control: Element, doc: Document): QuestionOption[] {
  const tag = control.tagName.toLowerCase();
  if (tag === 'select') {
    return Array.from((control as HTMLSelectElement).options)
      .filter((option) => option.value !== '' && !option.disabled)
      .map((option) => ({ label: normalizeText(option.textContent ?? ''), value: option.value }));
  }
  const type = (control.getAttribute('type') ?? '').toLowerCase();
  if (type === 'radio' || type === 'checkbox') {
    return groupInputs(control, doc).map((input) => {
      const label =
        doc.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ??
        input.closest('label')?.textContent ??
        input.value;
      return { label: normalizeText(label ?? ''), value: input.value };
    });
  }
  return [];
}

function isRequired(control: Element, label: string): boolean {
  const rawLabel = `${getAccessibleName(control)} ${control.closest('fieldset')?.querySelector('legend')?.textContent ?? ''}`;
  return (
    control.hasAttribute('required') ||
    control.getAttribute('aria-required') === 'true' ||
    /[*\u2731\u2020\u2021\u204e]|\((?:required|mandatory)\)|\[(?:required|mandatory)\]/i.test(
      rawLabel,
    ) ||
    /(^|\s)\*/.test(label) ||
    /\brequired\b/i.test(control.getAttribute('aria-label') ?? '')
  );
}

function currentValue(control: Element, doc: Document): AnswerValue {
  const tag = control.tagName.toLowerCase();
  if (tag === 'select') return (control as HTMLSelectElement).value || null;
  if (tag === 'textarea') return (control as HTMLTextAreaElement).value || null;
  if (tag === 'input') {
    const input = control as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') {
      const checked = groupInputs(control, doc).filter((entry) => entry.checked);
      if (checked.length === 0) return null;
      return input.type === 'checkbox'
        ? checked.map((entry) => entry.value)
        : (checked[0]?.value ?? null);
    }
    return input.value || null;
  }
  return null;
}

export function extractQuestions(doc: Document): QuestionDescriptor[] {
  const root = scope(doc);
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>('input, select, textarea, [role="combobox"]'),
  );
  const seenControls = new Set<Element>();
  const questions: QuestionDescriptor[] = [];

  for (const control of controls) {
    const type = questionType(control);
    if (type === 'unknown' || !isVisible(control)) continue;
    if (control instanceof HTMLInputElement && SKIP_TYPES.has(control.type)) continue;
    if (control.getAttribute('disabled') !== null) continue;
    if (seenControls.has(control)) continue;
    if (type === 'radio' || type === 'checkbox') {
      for (const input of groupInputs(control, doc)) seenControls.add(input);
    }

    const label = labelFor(control, doc);
    if (!label || DOCUMENT_FIELD.test(label)) continue;
    const options = optionsFor(control, doc);
    if ((type === 'radio' || type === 'checkbox') && options.length === 0) continue;

    const fingerprint = simpleHash(
      `${label}|${type}|${options.map((option) => option.label).join(',')}`,
    );
    questions.push({
      id: fingerprint,
      label,
      type,
      required:
        isRequired(control, label) ||
        groupInputs(control, doc).some((input) => isRequired(input, label)),
      options: options.length > 0 ? options : undefined,
      currentValue: currentValue(control, doc),
      fingerprint,
      answerSource: 'none',
    });
  }
  return questions;
}

function answerText(value: AnswerValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function findGroupControl(doc: Document, question: QuestionDescriptor): HTMLElement | null {
  const root = scope(doc);
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>('input, select, textarea, [role="combobox"]'),
  );
  const found = new Set<HTMLElement>();
  for (const control of controls) {
    if (questionType(control) !== question.type) continue;
    if (!isVisible(control) || control.hasAttribute('disabled')) continue;
    const label = labelFor(control, doc);
    if (
      simpleHash(
        `${label}|${question.type}|${optionsFor(control, doc)
          .map((option) => option.label)
          .join(',')}`,
      ) === question.id
    ) {
      const first = groupInputs(control, doc)[0];
      found.add(first ?? control);
    }
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

export async function fillQuestion(
  doc: Document,
  question: QuestionDescriptor,
  value: AnswerValue,
  signal?: AbortSignal,
  delay?: DelayRange,
): Promise<{ ok: boolean; error?: string }> {
  if (value === null || value === undefined) {
    return { ok: false, error: 'No answer value' };
  }
  const control = findGroupControl(doc, question);
  if (!control) return { ok: false, error: 'Question control not found' };

  if (question.type === 'radio' || question.type === 'checkbox') {
    const group = groupInputs(control, doc);
    const values = Array.isArray(value) ? value : [String(value)];
    if (
      group.length === 0 ||
      values.some((entry) => !group.some((input) => input.value === entry))
    ) {
      return { ok: false, error: 'Mapped option is no longer available' };
    }
    for (const input of group) {
      const shouldSelect = values.includes(input.value);
      if (
        question.type === 'radio' ? shouldSelect && !input.checked : shouldSelect !== input.checked
      ) {
        await humanDelay(delay, signal);
        clickElement(input);
      }
    }
    return group.every((input) => input.checked === values.includes(input.value))
      ? { ok: true }
      : { ok: false, error: 'Mapped option did not stay selected' };
  }

  if (question.type === 'select') {
    const select = control as HTMLSelectElement;
    const option = Array.from(select.options).find(
      (entry) => entry.value === String(value) && !entry.disabled,
    );
    if (option && selectNative(select, option.value)) return { ok: true };
    return { ok: false, error: 'Could not select option' };
  }

  if (question.type === 'combobox') {
    const list = await openCombobox(control, { timeoutMs: 3_000, signal });
    if (!list) return { ok: false, error: 'Could not open combobox' };
    await humanDelay(delay, signal);
    const option = question.options?.find((entry) => entry.value === String(value));
    const target = option ? pickOption(list, option.label) : null;
    if (target) return { ok: true };
    return { ok: false, error: 'Could not pick option' };
  }

  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    const text = answerText(value);
    clickElement(control);
    setNativeValue(control, text);
    try {
      await waitFor(() => (control.value === text ? true : null), { timeoutMs: 1_500, signal });
    } catch {
      return { ok: false, error: 'Value did not stick' };
    }
    return { ok: true };
  }
  return { ok: false, error: 'Unsupported question type' };
}

export interface FillQuestionsResult {
  filled: string[];
  unknown: QuestionDescriptor[];
  errors: string[];
}

export async function fillQuestions(
  doc: Document,
  questions: QuestionDescriptor[],
  matches: ReadonlyMap<string, AnswerMatch>,
  options: {
    signal?: AbortSignal;
    humanDelay?: DelayRange;
  },
): Promise<FillQuestionsResult> {
  const filled: string[] = [];
  const unknown: QuestionDescriptor[] = [];
  const errors: string[] = [];

  for (const question of questions) {
    const match = matches.get(question.id);
    if (
      !match ||
      match.questionId !== question.id ||
      match.source === 'none' ||
      match.value === undefined ||
      questions.filter((entry) => entry.id === question.id).length > 1
    ) {
      unknown.push(question);
      continue;
    }
    await humanDelay(options.humanDelay, options.signal);
    const result = await fillQuestion(
      doc,
      question,
      match.value,
      options.signal,
      options.humanDelay,
    );
    if (result.ok) {
      filled.push(question.id);
    } else {
      errors.push(`${question.label}: ${result.error ?? 'could not fill'}`);
      unknown.push(question);
    }
  }
  return { filled, unknown, errors };
}
