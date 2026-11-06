import { useMemo, useState } from 'react';
import type { Answer, AnswerValue } from '@/core/contracts';
import {
  deriveCategoryFromLabel,
  looksEeoLabel,
  looksSensitiveLabel,
} from '@/core/answers/answerDraft';
import { now } from '@/core/util/time';
import { Badge } from '@/ui/components/Badge';
import { Button } from '@/ui/components/Button';
import { Checkbox } from '@/ui/components/Checkbox';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { ErrorState } from '@/ui/components/ErrorState';
import { Field } from '@/ui/components/Field';
import { IconButton } from '@/ui/components/IconButton';
import { IconPlus, IconTrash } from '@/ui/components/icons';
import { Input } from '@/ui/components/Input';
import { ListInput } from '@/ui/components/ListInput';
import { Section } from '@/ui/components/Section';
import { Select } from '@/ui/components/Select';
import { Skeleton } from '@/ui/components/Skeleton';
import { ToggleRow } from '@/ui/components/ToggleRow';
import { Textarea } from '@/ui/components/Textarea';
import { useAnswers } from '@/ui/hooks/useAnswers';
import { useAppContext } from '@/ui/hooks/useAppContext';
import { QuestionsToAnswer } from './QuestionsToAnswer';

function displayValue(value: AnswerValue): string {
  if (value === null) return 'Not set';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function AnswersSection() {
  const app = useAppContext();
  const answers = useAnswers();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<AnswerValue>('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editAuto, setEditAuto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Answer | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newSensitive, setNewSensitive] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...answers.answers].sort((a, b) => {
        if (a.sensitive !== b.sensitive) return a.sensitive ? -1 : 1;
        return a.label.localeCompare(b.label);
      }),
    [answers.answers],
  );

  const startEdit = (answer: Answer): void => {
    setEditingId(answer.id);
    setEditValue(answer.value);
    setEditError(null);
    setEditAuto(answer.autoSubmitAllowed);
  };

  const saveEdit = async (answer: Answer): Promise<void> => {
    let value = editValue;
    if (answer.type === 'number') {
      if (value === null || String(value).trim() === '' || !Number.isFinite(Number(value))) {
        setEditError('Enter a valid number.');
        return;
      }
      value = Number(value);
    }
    setSaving(true);
    const error = await answers.save({
      ...answer,
      value,
      // M9: derive sensitivity from the label so a stale/manual `false` cannot
      // let a sensitive answer bypass the opt-in.
      sensitive:
        answer.sensitive || looksSensitiveLabel(answer.label) || looksEeoLabel(answer.label),
      category:
        answer.category && answer.category !== 'custom'
          ? answer.category
          : deriveCategoryFromLabel(answer.label),
      autoSubmitAllowed: editAuto,
      updatedAt: now(),
    });
    setSaving(false);
    if (error) {
      app.notify('error', error.message);
      return;
    }
    setEditingId(null);
    app.notify('success', 'Answer updated.');
  };

  const addAnswer = async (): Promise<void> => {
    const label = newLabel.trim();
    if (!label) {
      setAddError('Give the answer a question label.');
      return;
    }
    if (!newValue.trim()) {
      setAddError('Add the answer you want reused.');
      return;
    }
    setSaving(true);
    const derivedSensitive = newSensitive || looksSensitiveLabel(label) || looksEeoLabel(label);
    const error = await answers.save({
      id: `custom_${crypto.randomUUID()}`,
      label,
      aliases: [],
      type: 'text',
      value: newValue.trim(),
      category: deriveCategoryFromLabel(label),
      autoSubmitAllowed: true,
      sensitive: derivedSensitive,
      updatedAt: now(),
    });
    setSaving(false);
    if (error) {
      setAddError(error.message);
      return;
    }
    setNewLabel('');
    setNewValue('');
    setNewSensitive(false);
    setAddError(null);
    app.notify('success', 'Answer added.');
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    const error = await answers.remove(deleteTarget.id);
    setDeleting(false);
    if (error) app.notify('error', error.message);
    else {
      setDeleteTarget(null);
      app.notify('success', 'Answer deleted.');
    }
  };

  return (
    <Section
      id="answers"
      title="Answer bank"
      description="Handshook fills applications from these answers. Answers you enter are used automatically; turn one off to confirm it in Needs You for each job."
    >
      <QuestionsToAnswer answers={answers} />
      <div className="rounded-panel border border-line bg-surface p-3">
        {answers.loading && answers.answers.length === 0 ? <Skeleton lines={5} /> : null}

        {answers.error && answers.answers.length === 0 ? (
          <ErrorState error={answers.error} onRetry={() => void answers.refresh()} />
        ) : null}

        {!answers.loading && answers.answers.length === 0 ? (
          <p className="text-[11.5px] text-muted">
            No saved answers yet. Add the questions that come up most: work authorization, GPA,
            graduation date.
          </p>
        ) : null}

        <ul className="space-y-2">
          {sorted.map((answer) => {
            const editing = editingId === answer.id;
            const optionValues = answer.options
              ? Object.entries(answer.options).map(([label, value]) => ({ label, value }))
              : [];
            return (
              <li key={answer.id} className="rounded-lg border border-line bg-surface-2 p-2">
                <div className="flex items-start justify-between gap-1.5">
                  <div className="min-w-0">
                    <p className="break-words text-[12px] font-medium leading-snug text-ink">
                      {answer.label}
                    </p>
                    <p className="mt-0.5 break-words text-[11.5px] text-muted">
                      {displayValue(answer.value)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {answer.sensitive ? <Badge tone="warn">Sensitive</Badge> : null}
                    {answer.autoSubmitAllowed ? <Badge tone="accent">Auto</Badge> : null}
                  </div>
                </div>

                {editing ? (
                  <div className="mt-2 space-y-2 border-t border-line pt-2">
                    <Field label="Answer value" error={editError ?? undefined}>
                      {answer.type === 'checkbox' ? (
                        optionValues.length > 0 ? (
                          <fieldset>
                            <legend className="sr-only">Answer choices</legend>
                            {optionValues.map((option) => (
                              <Checkbox
                                key={option.value}
                                label={option.label}
                                checked={
                                  Array.isArray(editValue) && editValue.includes(option.value)
                                }
                                onChange={(checked) => {
                                  const selected = Array.isArray(editValue) ? editValue : [];
                                  setEditValue(
                                    checked
                                      ? [...selected, option.value]
                                      : selected.filter((entry) => entry !== option.value),
                                  );
                                }}
                              />
                            ))}
                          </fieldset>
                        ) : Array.isArray(editValue) ? (
                          <ListInput
                            values={editValue}
                            onValuesChange={setEditValue}
                            aria-label="Answer values"
                          />
                        ) : (
                          <Checkbox
                            label="Answer is yes"
                            checked={editValue === true}
                            onChange={setEditValue}
                          />
                        )
                      ) : optionValues.length > 0 ? (
                        <Select
                          value={typeof editValue === 'string' ? editValue : ''}
                          onChange={(event) => setEditValue(event.currentTarget.value)}
                          options={optionValues}
                          placeholder="Choose an answer"
                        />
                      ) : answer.type === 'textarea' ? (
                        <Textarea
                          value={typeof editValue === 'string' ? editValue : ''}
                          onChange={(event) => setEditValue(event.currentTarget.value)}
                        />
                      ) : (
                        <Input
                          type={
                            answer.type === 'number'
                              ? 'number'
                              : answer.type === 'date'
                                ? 'date'
                                : 'text'
                          }
                          value={
                            typeof editValue === 'string' || typeof editValue === 'number'
                              ? editValue
                              : ''
                          }
                          onChange={(event) => {
                            setEditValue(event.currentTarget.value);
                            setEditError(null);
                          }}
                        />
                      )}
                    </Field>
                    <ToggleRow
                      label="Allow autopilot to use this answer"
                      description={
                        answer.sensitive
                          ? 'Allow this answer and the applicable sensitive, EEO, and free-text settings before autopilot can submit it.'
                          : 'Off leaves this answer blank until you confirm it for the job. Global opt-ins and Review still apply.'
                      }
                      tone={answer.sensitive ? 'warn' : 'default'}
                      checked={editAuto}
                      onChange={setEditAuto}
                    />
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        loading={saving}
                        onClick={() => void saveEdit(answer)}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saving}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(answer)}>
                      Edit
                    </Button>
                    <IconButton
                      label={`Delete answer ${answer.label}`}
                      size="sm"
                      tone="danger"
                      onClick={() => setDeleteTarget(answer)}
                    >
                      <IconTrash size={13} />
                    </IconButton>
                    <span className="text-[10.5px] text-muted">{answer.category ?? 'custom'}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-3 border-t border-line pt-2">
          <p className="text-[12px] font-medium text-ink">Add a custom answer</p>
          <div className="mt-1.5 space-y-2">
            <Field label="Question">
              <Input
                value={newLabel}
                onChange={(event) => setNewLabel(event.currentTarget.value)}
                placeholder="Do you have a driver's license?"
              />
            </Field>
            <Field label="Answer">
              <Input
                value={newValue}
                onChange={(event) => setNewValue(event.currentTarget.value)}
                placeholder="Yes"
              />
            </Field>
            <ToggleRow
              label="This is sensitive"
              description="Requires an explicit opt-in before autopilot can submit it."
              checked={newSensitive}
              onChange={setNewSensitive}
            />
            {addError ? (
              <p role="alert" className="text-[11.5px] font-medium text-danger">
                {addError}
              </p>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<IconPlus size={13} />}
              loading={saving}
              onClick={() => void addAnswer()}
            >
              Add answer
            </Button>
          </div>
        </div>

        <p className="mt-2 text-[10.5px] leading-snug text-muted">
          Answer changes save immediately. Stored locally in this browser profile.
        </p>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this answer?"
        description={
          deleteTarget
            ? `“${deleteTarget.label}” will be removed. Jobs that already used it are unaffected.`
            : undefined
        }
        confirmLabel="Delete answer"
        tone="danger"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </Section>
  );
}
