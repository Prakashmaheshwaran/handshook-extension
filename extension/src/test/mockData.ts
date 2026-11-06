/**
 * Sanitized sample data for tests and the mock Handshake site.
 *
 * All employers, people, documents, and IDs are fictional. There are no real names,
 * emails, cookies, tokens, or resume content. Timestamps are deterministic (see
 * `factories.ts`) so E2E assertions and snapshots stay stable.
 *
 * E2E helpers (`tests/e2e/helpers/handshake.ts`) import this module directly, so keep
 * it free of browser-only APIs.
 */

import type {
  Answer,
  DocumentRecord,
  EngineState,
  Job,
  JobEvent,
  OnboardingState,
  QueueItem,
  Settings,
} from '../core/contracts';
import {
  makeAnswer,
  makeDocument,
  makeEngineState,
  makeEvent,
  makeJob,
  makeQueueItem,
  makeSettings,
  makeTimestamp,
} from './factories';

export const SAMPLE_DOCUMENTS: readonly DocumentRecord[] = [
  makeDocument(
    {
      id: 'document-0001',
      type: 'resume',
      title: 'Resume — Backend (2026)',
      filename: 'sample-backend-resume.pdf',
      isDefault: true,
    },
    1,
  ),
  makeDocument(
    {
      id: 'document-0002',
      type: 'resume',
      title: 'Resume — Product (2026)',
      filename: 'sample-product-resume.pdf',
    },
    2,
  ),
  makeDocument(
    {
      id: 'document-0003',
      type: 'cover_letter',
      title: 'Cover Letter — General',
      filename: 'sample-cover-letter.pdf',
    },
    3,
  ),
  makeDocument(
    {
      id: 'document-0004',
      type: 'transcript',
      title: 'Official Transcript',
      filename: 'sample-transcript.pdf',
    },
    4,
  ),
];

/**
 * Deliberately Review mode (the opt-out from full automation), 25 applications/day,
 * onboarding complete, one saved search. AI matching and page assist stay on, as in
 * the product defaults.
 */
export const SAMPLE_SETTINGS: Settings = makeSettings({
  mode: 'review',
  onboardingComplete: true,
  search: {
    savedSearches: [
      {
        id: 'search-0001',
        name: 'Software internships',
        url: 'https://app.joinhandshake.com/job-search?role=software&remote=true',
        enabled: true,
        createdAt: makeTimestamp(),
        updatedAt: makeTimestamp(),
      },
    ],
    activeSearchId: 'search-0001',
    maxPagesPerRun: 3,
    maxJobsPerRun: 100,
    minFitScore: 0.55,
    includeKeywords: ['software', 'backend', 'platform'],
    excludeKeywords: ['unpaid', 'commission only'],
    locations: ['Remote'],
    remoteOnly: true,
    employmentTypes: ['Internship', 'Co-op'],
  },
  pacing: {
    dailyCap: 25,
    hardCap: 100,
    maxConsecutiveFailures: 3,
    maxAttemptsPerJob: 2,
  },
  documents: {
    defaultResumeId: 'document-0001',
    defaultResumeName: 'Resume — Backend (2026)',
    additionalResumes: [{ id: 'document-0002', name: 'Resume — Product (2026)' }],
    coverLetterId: 'document-0003',
    coverLetterName: 'Cover Letter — General',
    transcriptId: 'document-0004',
    transcriptName: 'Official Transcript',
    autoSelectResume: true,
  },
  ai: {
    enabled: true,
    pageAssist: true,
    answerAssist: true,
    answerWrite: true,
  },
  safety: {
    reviewBeforeSubmit: true,
    allowSensitiveAutoSubmit: false,
    allowEeoAutoFill: false,
    allowFreeTextAutoFill: false,
    stopOnUnknownQuestion: true,
    verifySubmissions: true,
  },
});

export const SAMPLE_JOB_COUNT = 10;

/**
 * Ten search results: quick apply, handshake forms with one or two required
 * documents, one external apply, one already applied (900007), one closed (900009),
 * and one below the fit threshold (900010).
 */
export const SAMPLE_JOBS: readonly Job[] = [
  makeJob(
    {
      id: '900001',
      title: 'Software Engineering Intern',
      employer: 'Northwind Labs',
      applyType: 'quick_apply',
      requiredDocumentTypes: ['resume'],
      location: 'Remote',
      employmentType: 'Internship',
      salary: '$32/hour',
      fitScore: 0.91,
      fitReasons: ['Matches include keyword "software"', 'Remote'],
      postedAt: '2026-01-10T09:00:00.000Z',
    },
    1,
  ),
  makeJob(
    {
      id: '900002',
      title: 'Data Analyst Intern',
      employer: 'Contoso Analytics',
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume', 'cover_letter'],
      location: 'New York, NY',
      employmentType: 'Internship',
      fitScore: 0.78,
      fitReasons: ['Matches include keyword "platform"'],
      postedAt: '2026-01-09T15:30:00.000Z',
    },
    2,
  ),
  makeJob(
    {
      id: '900003',
      title: 'Backend Developer Co-op',
      employer: 'Initech Systems',
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume', 'transcript'],
      location: 'Austin, TX',
      employmentType: 'Co-op',
      fitScore: 0.86,
      fitReasons: ['Matches include keyword "backend"'],
      postedAt: '2026-01-08T11:15:00.000Z',
    },
    3,
  ),
  makeJob(
    {
      id: '900004',
      title: 'Frontend Engineer Intern',
      employer: 'Globex Digital',
      applyType: 'quick_apply',
      requiredDocumentTypes: ['resume'],
      location: 'Remote',
      employmentType: 'Internship',
      remote: true,
      fitScore: 0.83,
      fitReasons: ['Remote', 'Matches include keyword "software"'],
      postedAt: '2026-01-07T08:45:00.000Z',
    },
    4,
  ),
  makeJob(
    {
      id: '900005',
      title: 'Research Assistant',
      employer: 'Fabrikam University',
      applyType: 'external',
      requiredDocumentTypes: ['resume'],
      location: 'On campus',
      employmentType: 'Part-time',
      fitScore: 0.72,
      fitReasons: ['Matches include keyword "software"'],
      postedAt: '2026-01-06T17:20:00.000Z',
    },
    5,
  ),
  makeJob(
    {
      id: '900006',
      title: 'Product Design Intern',
      employer: 'Umbrella Studio',
      applyType: 'quick_apply',
      requiredDocumentTypes: ['resume'],
      location: 'Remote',
      employmentType: 'Internship',
      remote: true,
      fitScore: 0.69,
      fitReasons: ['Remote'],
      postedAt: '2026-01-05T13:05:00.000Z',
    },
    6,
  ),
  makeJob(
    {
      id: '900007',
      title: 'QA Automation Intern',
      employer: 'Acme Robotics',
      applyType: 'quick_apply',
      requiredDocumentTypes: ['resume'],
      location: 'Remote',
      employmentType: 'Internship',
      remote: true,
      fitScore: 0.81,
      fitReasons: ['Remote', 'Matches include keyword "software"'],
      postedAt: '2026-01-04T10:40:00.000Z',
    },
    7,
  ),
  makeJob(
    {
      id: '900008',
      title: 'Machine Learning Intern',
      employer: 'Soylent AI',
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume', 'transcript'],
      location: 'San Francisco, CA',
      employmentType: 'Internship',
      fitScore: 0.88,
      fitReasons: ['Matches include keyword "backend"', 'Matches include keyword "platform"'],
      postedAt: '2026-01-03T16:00:00.000Z',
    },
    8,
  ),
  makeJob(
    {
      id: '900009',
      title: 'DevOps Intern',
      employer: 'Vandelay Cloud',
      applyType: 'quick_apply',
      requiredDocumentTypes: ['resume'],
      location: 'Remote',
      employmentType: 'Internship',
      remote: true,
      fitScore: 0.76,
      fitReasons: ['Remote'],
      postedAt: '2026-01-02T09:10:00.000Z',
    },
    9,
  ),
  makeJob(
    {
      id: '900010',
      title: 'Technical Writer Intern',
      employer: 'Hooli Docs',
      applyType: 'handshake_form',
      requiredDocumentTypes: ['resume', 'cover_letter'],
      location: 'Remote',
      employmentType: 'Internship',
      remote: true,
      fitScore: 0.42,
      fitReasons: ['Below minimum fit score'],
      postedAt: '2026-01-01T12:00:00.000Z',
    },
    10,
  ),
];

/** Queue states covering every interesting branch of the queue UI. */
export const SAMPLE_QUEUE: readonly QueueItem[] = [
  makeQueueItem({ jobId: '900001', status: 'ready_for_review', priority: 90, attempts: 1 }, 1),
  makeQueueItem({ jobId: '900002', status: 'queued', priority: 80, attempts: 0 }, 2),
  makeQueueItem(
    {
      jobId: '900003',
      status: 'needs_input',
      priority: 70,
      attempts: 1,
      pendingQuestionIds: ['question-0001', 'question-0002'],
    },
    3,
  ),
  makeQueueItem({ jobId: '900004', status: 'queued', priority: 60, attempts: 0 }, 4),
  makeQueueItem({ jobId: '900005', status: 'external', priority: 50, attempts: 1 }, 5),
  makeQueueItem({ jobId: '900006', status: 'queued', priority: 40, attempts: 0 }, 6),
  makeQueueItem({ jobId: '900007', status: 'already_applied', priority: 30, attempts: 1 }, 7),
  makeQueueItem({ jobId: '900008', status: 'queued', priority: 20, attempts: 0 }, 8),
  makeQueueItem({ jobId: '900009', status: 'skipped', priority: 10, attempts: 1 }, 9),
  makeQueueItem({ jobId: '900010', status: 'filtered', priority: 0, attempts: 0 }, 10),
];

/** Reusable answers. Sensitive entries never allow auto-submit in the sample. */
export const SAMPLE_ANSWERS: readonly Answer[] = [
  makeAnswer(
    {
      id: 'work_authorization',
      label: 'Are you legally authorized to work in the United States?',
      aliases: ['work authorization', 'authorized to work', 'legally authorized'],
      type: 'radio',
      value: 'yes',
      options: { yes: 'yes', no: 'no' },
      category: 'work',
      sensitive: true,
      autoSubmitAllowed: false,
    },
    1,
  ),
  makeAnswer(
    {
      id: 'sponsorship_required',
      label: 'Will you now or in the future require sponsorship?',
      aliases: ['sponsorship', 'visa sponsorship'],
      type: 'radio',
      value: 'no',
      options: { yes: 'yes', no: 'no' },
      category: 'work',
      sensitive: true,
      autoSubmitAllowed: false,
    },
    2,
  ),
  makeAnswer(
    {
      id: 'degree_type',
      label: 'What degree are you pursuing?',
      aliases: ['degree', 'major'],
      type: 'select',
      value: 'bachelors',
      options: { "bachelor's": 'bachelors', "master's": 'masters', doctorate: 'doctorate' },
      category: 'education',
      autoSubmitAllowed: true,
    },
    3,
  ),
  makeAnswer(
    {
      id: 'gpa',
      label: 'What is your GPA?',
      aliases: ['grade point average'],
      type: 'number',
      value: 3.7,
      category: 'education',
      autoSubmitAllowed: true,
    },
    4,
  ),
  makeAnswer(
    {
      id: 'earliest_start_date',
      label: 'When can you start?',
      aliases: ['earliest start', 'available start date'],
      type: 'date',
      value: '2026-06-01',
      category: 'preferences',
      autoSubmitAllowed: true,
    },
    5,
  ),
  makeAnswer(
    {
      id: 'gender_identity',
      label: 'Gender identity',
      aliases: ['gender'],
      type: 'select',
      value: 'decline',
      options: { 'Decline to self-identify': 'decline' },
      category: 'eeo',
      sensitive: true,
      autoSubmitAllowed: false,
    },
    6,
  ),
  makeAnswer(
    {
      id: 'relocation',
      label: 'Are you willing to relocate?',
      aliases: ['relocate', 'relocation'],
      type: 'radio',
      value: 'yes',
      options: { yes: 'yes', no: 'no' },
      category: 'preferences',
      autoSubmitAllowed: true,
    },
    7,
  ),
  makeAnswer(
    {
      id: 'why_this_company',
      label: 'Why are you interested in this role?',
      aliases: ['why this company', 'interest in role'],
      type: 'textarea',
      value: 'I am excited about building reliable tools with a small team.',
      category: 'custom',
      autoSubmitAllowed: false,
    },
    8,
  ),
];

/** Recent structured events for the activity/log screen. */
export const SAMPLE_EVENTS: readonly JobEvent[] = [
  makeEvent(
    { type: 'scan.started', message: 'Scanning saved search', level: 'info', data: { pages: 1 } },
    1,
  ),
  makeEvent(
    {
      type: 'scan.complete',
      message: 'Found 10 jobs',
      level: 'info',
      data: { found: 10, pages: 1 },
    },
    2,
  ),
  makeEvent(
    { type: 'job.applied', jobId: '900001', message: 'Application submitted', level: 'info' },
    3,
  ),
  makeEvent(
    {
      type: 'engine.paused',
      message: 'Paused for review',
      level: 'warn',
      data: { reason: 'user' },
    },
    4,
  ),
  makeEvent(
    {
      type: 'selector.miss',
      jobId: '900009',
      message: 'Apply button not found',
      level: 'error',
      data: { strategy: 'apply.button' },
    },
    5,
  ),
  makeEvent(
    {
      type: 'job.needs_input',
      jobId: '900003',
      message: 'Unknown screening question',
      level: 'warn',
    },
    6,
  ),
];

/** Idle review-mode engine with three applications already counted today. */
export const SAMPLE_ENGINE_STATE: EngineState = makeEngineState({
  status: 'idle',
  mode: 'review',
  todayCount: 3,
  dailyCap: 25,
});

/** Paused after repeated failures, useful for paused/backoff UI states. */
export const SAMPLE_ENGINE_STATE_PAUSED: EngineState = makeEngineState({
  status: 'paused',
  mode: 'autopilot',
  pauseReason: 'too_many_failures',
  todayCount: 3,
  dailyCap: 25,
  pausedAt: makeTimestamp(-60_000),
  message: 'Paused after repeated failures',
});

/** Onboarding finished. */
export const SAMPLE_ONBOARDING: OnboardingState = {
  version: 1,
  step: 'done',
  host: 'app.joinhandshake.com',
  sessionStatus: 'logged_in',
  answersConfigured: true,
  searchConfigured: true,
  completedAt: makeTimestamp(-86_400_000),
};

/** First-run onboarding, before the user does anything. */
export const SAMPLE_ONBOARDING_FRESH: OnboardingState = {
  version: 1,
  step: 'welcome',
  host: 'app.joinhandshake.com',
  sessionStatus: 'unknown',
};
