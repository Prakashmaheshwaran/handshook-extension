import { useMemo, useState } from 'react';
import type { Answer, AnswerValue, InboxQuestion, QuestionType } from '@/core/contracts';
import {
  deriveCategoryFromLabel,
  looksEeoLabel,
  looksSensitiveLabel,
} from '@/core/answers/answerDraft';
import { simpleHash } from '@/core/util/hash';
import { now } from '@/core/util/time';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Field } from '@/ui/components/Field';
import { Input } from '@/ui/components/Input';
import { RadioGroup } from '@/ui/components/RadioGroup';
import { Select } from '@/ui/components/Select';
import type { AnswersController } from '@/ui/hooks/useAnswers';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { useQuestionInbox } from '@/ui/hooks/useQuestionInbox';
import { normalizeText } from '@/handshake/text';
import { ANSWER_TEMPLATES } from '@/ui/screens/Onboarding/defaults';

/** One row the user can answer: a question a form asked, or a common one. */
interface Pending {
  key: string;
  label: string;
  type: QuestionType;
  options: { label: string; value: string }[];
  required: boolean;
  /** `run`/`scan` came from a real form; `common` is a suggested question. */
  source: InboxQuestion['source'] | 'common';
  seenCount: number;
  build: (value: AnswerValue) => Answer;
  initial: AnswerValue;
}

/** Form labels are stored normalized; show them as a sentence. */
function sentence(label: string): string {
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

function answered(answers: readonly Answer[]): Set<string> {
  const labels = new Set<string>();
  for (const answer of answers) {
    const value = answer.value;
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    for (const label of [answer.label, ...answer.aliases]) labels.add(normalizeText(label));
  }
  return labels;
}

function fromInbox(question: InboxQuestion): Pending {
  const label = sentence(question.label);
  const options = question.options ?? [];
  return {
    key: question.key,
    label,
    type: question.type,
    options,
    required: question.required,
    source: question.source,
    seenCount: question.seenCount,
    initial: '',
    build: (value) => {
      const sensitive = looksSensitiveLabel(label) || looksEeoLabel(label);
      return {
        id: `asked_${simpleHash(question.key)}`,
        label,
        aliases: [],
        type: question.type,
        value,
        ...(options.length
          ? { options: Object.fromEntries(options.map((option) => [option.label, option.value])) }
          : {}),
        category: deriveCategoryFromLabel(`${question.section ?? ''} ${label}`),
        autoSubmitAllowed: true,
        sensitive,
        updatedAt: now(),
      };
    },
  };
}

function hasValue(value: AnswerValue): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return !Array.isArray(value) || value.length > 0;
}

export interface QuestionsToAnswerProps {
  answers: AnswersController;
}

/**
 * Settings → Answers: questions Handshook met and could not answer, plus the
 * common screening questions not saved yet. Each answer is saved once to the
 * answer bank; jobs already waiting on it go back in the queue.
 */
export function QuestionsToAnswer({ answers }: QuestionsToAnswerProps) {
  const app = useAppContext();
  const inbox = useQuestionInbox();
  const [values, setValues] = useState<Record<string, AnswerValue>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const pending = useMemo<Pending[]>(() => {
    const done = answered(answers.answers);
    const savedIds = new Set(answers.answers.map((answer) => answer.id));
    const asked = inbox.questions.map(fromInbox);
    const askedLabels = new Set(asked.map((item) => normalizeText(item.label)));
    const common = ANSWER_TEMPLATES.filter(
      (template) =>
        !savedIds.has(template.id) &&
        !done.has(normalizeText(template.label)) &&
        !askedLabels.has(normalizeText(template.label)),
    ).map<Pending>((template) => ({
      key: `common|${template.id}`,
      label: template.label,
      type: template.type,
      options: Object.entries(template.options ?? {}).map(([label, value]) => ({ label, value })),
      required: false,
      source: 'common',
      seenCount: 0,
      initial: template.defaultValue,
      build: (value) => ({
        id: template.id,
        label: template.label,
        aliases: template.aliases,
        type: template.type,
        value,
        ...(template.options ? { options: template.options } : {}),
        category: template.category,
        autoSubmitAllowed: true,
        sensitive: template.sensitive,
        updatedAt: now(),
      }),
    }));
    return [...asked, ...common];
  }, [answers.answers, inbox.questions]);

  if (pending.length === 0) return null;

  const valueFor = (item: Pending): AnswerValue => values[item.key] ?? item.initial;
  const save = async (item: Pending): Promise<void> => {
    const value = valueFor(item);
    if (!hasValue(value)) return;
    setBusy(item.key);
    const error = await answers.save(item.build(value));
    setBusy(null);
    if (error) {
      app.notify('error', error.message);
      return;
    }
    await inbox.refresh();
    app.notify('success', 'Answer saved. Jobs waiting on it will continue.');
  };
  const dismiss = async (item: Pending): Promise<void> => {
    setBusy(item.key);
    const error = await inbox.dismiss(item.key);
    setBusy(null);
    if (error) app.notify('error', error.message);
  };

  const askedCount = pending.filter((item) => item.source !== 'common').length;
  return (
    <div className="mb-3 rounded-panel border border-accent/30 bg-accent-soft/40 p-3">
      <p className="text-[12.5px] font-medium text-ink">Questions to answer</p>
      <p className="mt-0.5 text-[11.5px] leading-snug text-muted">
        {askedCount > 0
          ? `${askedCount} question${askedCount === 1 ? '' : 's'} from application forms had no saved answer. `
          : ''}
        Answer each once and Handshook uses it on every application that asks.
      </p>
      <ul className="mt-2 space-y-2">
        {pending.map((item) => {
          const value = valueFor(item);
          const text = typeof value === 'string' ? value : '';
          return (
            <li key={item.key} className="rounded-lg border border-line bg-surface p-2">
              <div className="flex items-start justify-between gap-1.5">
                <p className="min-w-0 break-words text-[12px] font-medium leading-snug text-ink">
                  {item.label}
                </p>
                <div className="flex shrink-0 gap-1">
                  {item.source === 'common' ? <Badge>Common</Badge> : null}
                  {item.required ? <Badge tone="warn">Required</Badge> : null}
                  {item.seenCount > 1 ? <Badge>Asked {item.seenCount}×</Badge> : null}
                </div>
              </div>
              <div className="mt-1.5">
                {item.type === 'radio' && item.options.length > 0 ? (
                  <RadioGroup
                    legend={item.label}
                    name={`inbox-${item.key}`}
                    value={text}
                    onChange={(next) => setValues((current) => ({ ...current, [item.key]: next }))}
                    options={item.options}
                    className="[&>legend]:sr-only"
                  />
                ) : item.options.length > 0 ? (
                  <Field label="Your answer" hideLabel>
                    <Select
                      value={text}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setValues((current) => ({ ...current, [item.key]: next }));
                      }}
                      options={item.options}
                      placeholder="Choose an answer"
                    />
                  </Field>
                ) : (
                  <Field label="Your answer" hideLabel>
                    <Input
                      type={item.type === 'date' ? 'date' : 'text'}
                      value={text}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setValues((current) => ({ ...current, [item.key]: next }));
                      }}
                      placeholder="Type your answer"
                    />
                  </Field>
                )}
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === item.key}
                  disabled={!hasValue(value) || busy !== null}
                  onClick={() => void save(item)}
                >
                  Save answer
                </Button>
                {item.source === 'common' ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void dismiss(item)}
                  >
                    Don’t ask again
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
