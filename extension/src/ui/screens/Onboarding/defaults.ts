import type { Answer, AnswerValue, QuestionType } from '@/core/contracts';

export interface AnswerTemplate {
  id: string;
  label: string;
  aliases: string[];
  type: QuestionType;
  category: Answer['category'];
  sensitive: boolean;
  options?: Record<string, string>;
  defaultValue: AnswerValue;
  hint?: string;
}

/**
 * The answers that unblock most Handshake applications: the original seven
 * plus the screening questions employers commonly add. Values start empty
 * (except the non-personal "how did you hear") so nothing personal is invented.
 */
export const ANSWER_TEMPLATES: readonly AnswerTemplate[] = [
  {
    id: 'work_authorization',
    label: 'Are you legally authorized to work in the United States?',
    aliases: ['work authorization', 'legally authorized', 'right to work'],
    type: 'radio',
    category: 'work',
    sensitive: true,
    options: { Yes: 'yes', No: 'no' },
    defaultValue: '',
    hint: 'Optional during setup. Answer accurately when a job asks.',
  },
  {
    id: 'sponsorship',
    label: 'Will you now or in the future require sponsorship?',
    aliases: ['sponsorship', 'visa sponsorship'],
    type: 'radio',
    category: 'work',
    sensitive: true,
    options: { Yes: 'yes', No: 'no' },
    defaultValue: '',
  },
  {
    id: 'gpa',
    label: 'Cumulative GPA',
    aliases: ['gpa', 'grade point average'],
    type: 'text',
    category: 'education',
    sensitive: false,
    defaultValue: '',
    hint: 'Optional. Leave blank if you would rather answer per job.',
  },
  {
    id: 'graduation_date',
    label: 'Expected graduation date',
    aliases: ['graduation date', 'grad date'],
    type: 'date',
    category: 'education',
    sensitive: false,
    defaultValue: '',
    hint: 'Optional during setup. You can add this later or answer per job.',
  },
  {
    id: 'preferred_location',
    label: 'Preferred work location',
    aliases: ['location preference', 'preferred location'],
    type: 'text',
    category: 'preferences',
    sensitive: false,
    defaultValue: '',
    hint: 'Free text, e.g. “Remote” or “New York, NY”.',
  },
  {
    id: 'major',
    label: 'Major or field of study',
    aliases: ['major', 'field of study', 'area of study', 'concentration', 'program of study'],
    type: 'text',
    category: 'education',
    sensitive: false,
    defaultValue: '',
  },
  {
    id: 'degree_level',
    label: 'Degree you are pursuing',
    aliases: ['degree level', 'degree type', 'highest degree', 'level of education', 'degree'],
    type: 'select',
    category: 'education',
    sensitive: false,
    options: {
      Associate: 'associate',
      "Bachelor's": 'bachelors',
      "Master's": 'masters',
      'PhD / Doctorate': 'doctorate',
      Other: 'other',
    },
    defaultValue: '',
  },
  {
    id: 'school',
    label: 'School or university',
    aliases: ['university', 'college', 'school', 'school name', 'institution', 'current school'],
    type: 'text',
    category: 'education',
    sensitive: false,
    defaultValue: '',
  },
  {
    id: 'start_date',
    label: 'Earliest start date',
    aliases: ['start date', 'available start date', 'availability date', 'when can you start'],
    type: 'date',
    category: 'work',
    sensitive: false,
    defaultValue: '',
  },
  {
    id: 'relocate',
    label: 'Are you willing to relocate?',
    aliases: ['willing to relocate', 'relocation', 'open to relocation', 'relocate'],
    type: 'radio',
    category: 'preferences',
    sensitive: false,
    options: { Yes: 'yes', No: 'no' },
    defaultValue: '',
  },
  {
    id: 'onsite',
    label: 'Are you able to work on-site or hybrid?',
    aliases: ['work on-site', 'onsite', 'in person', 'in-office', 'hybrid', 'work in office'],
    type: 'radio',
    category: 'preferences',
    sensitive: false,
    options: { Yes: 'yes', No: 'no' },
    defaultValue: '',
  },
  {
    id: 'age_18',
    label: 'Are you at least 18 years old?',
    aliases: ['at least 18', '18 years of age', 'over 18', '18 or older', 'legal age'],
    type: 'radio',
    category: 'work',
    sensitive: false,
    options: { Yes: 'yes', No: 'no' },
    defaultValue: '',
  },
  {
    id: 'heard_about',
    label: 'How did you hear about this position?',
    aliases: [
      'how did you hear',
      'how did you hear about us',
      'where did you hear about this job',
      'how did you find this job',
      'how did you learn about this position',
    ],
    type: 'text',
    category: 'custom',
    sensitive: false,
    defaultValue: 'Handshake',
  },
  {
    id: 'linkedin_url',
    label: 'LinkedIn profile URL',
    aliases: ['linkedin', 'linkedin url', 'linkedin profile'],
    type: 'text',
    category: 'identity',
    sensitive: false,
    defaultValue: '',
  },
  {
    id: 'portfolio_url',
    label: 'Portfolio or GitHub URL',
    aliases: ['portfolio', 'github', 'personal website', 'website url', 'portfolio url'],
    type: 'text',
    category: 'identity',
    sensitive: false,
    defaultValue: '',
  },
  {
    id: 'salary_expectation',
    label: 'Salary expectations',
    aliases: ['salary', 'compensation', 'hourly rate'],
    type: 'text',
    category: 'preferences',
    sensitive: true,
    defaultValue: '',
    hint: 'Optional. Many students leave this blank and answer per job.',
  },
  {
    id: 'eeo_preference',
    label: 'Voluntary self-identification preference',
    aliases: ['eeo', 'veteran status', 'disability status', 'gender', 'race'],
    type: 'select',
    category: 'eeo',
    sensitive: true,
    options: {
      'Prefer not to say': 'decline',
      'Prefer to answer per application': 'per_job',
    },
    defaultValue: 'decline',
    hint: 'Handshook never fills EEO blocks unless you allow it in Settings.',
  },
];

export function defaultAnswers(now = Date.now()): Answer[] {
  return ANSWER_TEMPLATES.map((template) => ({
    id: template.id,
    label: template.label,
    aliases: template.aliases,
    type: template.type,
    value: template.defaultValue,
    options: template.options,
    category: template.category,
    // Full automation: an answer the user enters is used automatically. Each
    // answer can still be opted out, and sensitive ones follow the global switch.
    autoSubmitAllowed: true,
    sensitive: template.sensitive,
    updatedAt: now,
  }));
}

export function templateFor(id: string): AnswerTemplate | undefined {
  return ANSWER_TEMPLATES.find((template) => template.id === id);
}
