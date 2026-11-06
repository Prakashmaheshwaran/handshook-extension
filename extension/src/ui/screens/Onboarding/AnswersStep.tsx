import type { Answer } from '@/core/contracts';
import { Badge } from '@/ui/components/Badge';
import { Card } from '@/ui/components/Card';
import { Checkbox } from '@/ui/components/Checkbox';
import { Field } from '@/ui/components/Field';
import { Input } from '@/ui/components/Input';
import { RadioGroup } from '@/ui/components/RadioGroup';
import { Select } from '@/ui/components/Select';
import { templateFor } from './defaults';

export interface AnswersStepProps {
  answers: Answer[];
  onChange: (answerId: string, patch: Partial<Answer>) => void;
}

export function AnswersStep({ answers, onChange }: AnswersStepProps) {
  return (
    <div className="space-y-3">
      <Card>
        <h2 className="text-[14px] font-semibold text-ink">Reusable answers</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          You can add answers later. Jobs with questions you haven't answered wait in Needs you.
          Press Continue to save any answers you entered and move on.
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <Badge tone="warn">Sensitive</Badge>
          answers need your review unless you approve the answer below and also allow sensitive
          auto-submit in Settings → Run mode and safety.
        </p>
      </Card>

      <div className="space-y-2">
        {answers.map((answer) => {
          const template = templateFor(answer.id);
          const options = answer.options
            ? Object.entries(answer.options).map(([label, value]) => ({ label, value }))
            : [];
          return (
            <Card key={answer.id} padded={false} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium leading-snug text-ink">{answer.label}</p>
                  {template?.hint ? (
                    <p className="mt-0.5 text-[11px] leading-snug text-muted">{template.hint}</p>
                  ) : null}
                </div>
                {answer.sensitive ? <Badge tone="warn">Sensitive</Badge> : null}
              </div>

              <div className="mt-2">
                {answer.type === 'radio' && options.length > 0 ? (
                  <RadioGroup
                    legend={answer.label}
                    name={`answer-${answer.id}`}
                    value={typeof answer.value === 'string' ? answer.value : ''}
                    onChange={(value) => onChange(answer.id, { value })}
                    options={options}
                    className="[&>legend]:sr-only"
                  />
                ) : options.length > 0 ? (
                  <Field label="Your answer" hideLabel>
                    <Select
                      value={typeof answer.value === 'string' ? answer.value : ''}
                      onChange={(event) =>
                        onChange(answer.id, { value: event.currentTarget.value })
                      }
                      options={options}
                      placeholder="Choose an answer"
                    />
                  </Field>
                ) : (
                  <Field label="Your answer" hideLabel>
                    <Input
                      type={answer.type === 'date' ? 'date' : 'text'}
                      value={typeof answer.value === 'string' ? answer.value : ''}
                      onChange={(event) =>
                        onChange(answer.id, { value: event.currentTarget.value })
                      }
                      placeholder={
                        template?.id === 'graduation_date' ? undefined : 'Type your answer'
                      }
                    />
                  </Field>
                )}
              </div>

              {answer.sensitive ? (
                <div className="mt-2 rounded-lg border border-warn/30 bg-warn-soft/60 p-2">
                  <Checkbox
                    label="Allow autopilot to submit this answer without review"
                    description="On by default. Turn it off to confirm this answer in Needs you for each job."
                    checked={answer.autoSubmitAllowed}
                    onChange={(autoSubmitAllowed) => onChange(answer.id, { autoSubmitAllowed })}
                  />
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <p className="text-[11px] leading-snug text-muted">
        Answers are stored in this browser profile only. You can edit or delete them any time in
        Settings → Answer bank.
      </p>
    </div>
  );
}
