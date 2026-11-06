import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApplyType, DocumentType, SelectorStrategy } from '@/core/contracts';
import { classifyApplyType } from '@/handshake/applyType';
import { selectDocument } from '@/handshake/documents';
import { extractJobCards, scanPage } from '@/handshake/discovery';
import { resetSelectorHealth } from '@/handshake/health';
import { parseHandshakeHost } from '@/handshake/host';
import { detectJobPageState, extractJobFromDom } from '@/handshake/jobDetails';
import { extractQuestions } from '@/handshake/questions';
import { discoverySelectors } from '@/handshake/selectors/discovery';
import { jobSelectors } from '@/handshake/selectors/job';
import { normalizeText } from '@/handshake/text';
import {
  detectAlreadyApplied,
  detectConfirmation,
  isApplicationModalOpen,
} from '@/handshake/verification';

const FIXTURES_ROOT = process.env.HANDSHOOK_LIVE_FIXTURES
  ? resolve(process.env.HANDSHOOK_LIVE_FIXTURES)
  : resolve(process.cwd(), 'tests/fixtures/live');

const EXPECTED_APPLY: Readonly<Record<string, ApplyType>> = {
  'job-quick': 'quick_apply',
  'job-form': 'handshake_form',
  'job-external': 'external',
};

const globalRecord = globalThis as unknown as Record<string, unknown>;
if (typeof globalRecord.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {
      escape: (value: string): string =>
        value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`),
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function listHtmlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...listHtmlFiles(child));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) output.push(child);
  }
  return output.sort();
}

function readMeta(htmlPath: string): Record<string, unknown> {
  const metaPath = htmlPath.replace(/\.html$/i, '.json');
  if (!existsSync(metaPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function loadFixture(file: string): void {
  const parsed = new DOMParser().parseFromString(readFileSync(file, 'utf8'), 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  document.title = parsed.title;
}

function selectorReport(
  groups: Readonly<Record<string, readonly SelectorStrategy[]>>,
  root: ParentNode,
): string[] {
  const lines: string[] = [];
  for (const [group, strategies] of Object.entries(groups)) {
    let match: string | null = null;
    for (const strategy of strategies) {
      try {
        if (strategy.find(root)) {
          match = strategy.name;
          break;
        }
      } catch {
        /* A throwing strategy is reported as a miss, exactly like runStrategy. */
      }
    }
    lines.push(`${group}: ${match ? `HIT (${match})` : 'MISS'}`);
  }
  return lines;
}

function logReport(file: string, lines: readonly string[]): void {
  console.log(`\n[live-selectors] ${relative(FIXTURES_ROOT, file)}`);
  for (const line of lines) console.log(`  ${line}`);
}

function jobIdFromUrl(url: string): string | null {
  return /(?:stu\/)?jobs\/(\d{1,20})/.exec(url)?.[1] ?? null;
}

function normalizeApplyType(value: string): ApplyType {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (normalized === 'quick_apply' || normalized === 'quick') return 'quick_apply';
  if (normalized === 'external' || normalized === 'external_apply') return 'external';
  return 'handshake_form';
}

function fixtureInfo(
  file: string,
  meta: Record<string, unknown>,
): {
  pageType: string;
  sourceUrl: string;
  host: string;
  expected: Record<string, unknown>;
} {
  const fixture = asRecord(meta.fixture) ?? {};
  const expected = asRecord(meta.expected) ?? {};
  const fallbackHost = 'app.joinhandshake.com';
  const candidateHost = asString(fixture.host);
  const host = candidateHost && parseHandshakeHost(candidateHost) ? candidateHost : fallbackHost;
  const candidateUrl = asString(fixture.sourceUrl);
  return {
    pageType: asString(fixture.pageType) ?? basename(dirname(file)),
    sourceUrl:
      candidateUrl && candidateUrl.length > 0 ? candidateUrl : `https://${host}/job-search`,
    host,
    expected,
  };
}

const fixtures = listHtmlFiles(FIXTURES_ROOT);

describe('live selector health', () => {
  it('has sanitized live fixtures to verify selectors against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  beforeEach(() => {
    resetSelectorHealth();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  for (const file of fixtures) {
    it(`extracts expected data from ${relative(FIXTURES_ROOT, file)}`, async () => {
      loadFixture(file);
      const meta = readMeta(file);
      const { pageType, sourceUrl, host, expected } = fixtureInfo(file, meta);
      const lines: string[] = [`pageType: ${pageType}`, `url: ${sourceUrl}`, `host: ${host}`];

      switch (pageType) {
        case 'search': {
          lines.push(...selectorReport(discoverySelectors, document));
          const jobs = extractJobCards(document, host);
          lines.push(`jobs: ${jobs.length} [${jobs.map((job) => job.id).join(', ')}]`);
          const expectedIds = asStringArray(expected.jobIds);
          if (expectedIds.length > 0) {
            expect(jobs.map((job) => job.id)).toEqual(expect.arrayContaining(expectedIds));
          }
          for (const job of jobs) {
            expect(job.id).toMatch(/^\d+$/);
            expect(job.title.length).toBeGreaterThan(0);
          }
          const scan = scanPage(document, sourceUrl, host);
          expect(scan.jobs).toHaveLength(jobs.length);
          lines.push(`emptyState: ${scan.empty}`);
          lines.push(`nextPage: ${scan.nextPageUrl ?? 'none'}`);
          break;
        }

        case 'job-quick':
        case 'job-form':
        case 'job-external':
        case 'job-applied':
        case 'job-detail': {
          lines.push(...selectorReport(jobSelectors, document));
          const jobId =
            asStringArray(expected.jobIds)[0] ??
            asString(expected.jobIdFromUrl) ??
            jobIdFromUrl(sourceUrl) ??
            '10000001';
          const state = detectJobPageState(document);
          const job = extractJobFromDom(document, host, jobId);
          lines.push(`state: ${state ?? 'applyable'}`);
          lines.push(`title: ${job.title || '(empty)'}`);
          lines.push(`employer: ${job.employer || '(empty)'}`);
          lines.push(`applyType: ${classifyApplyType(document)}`);

          if (state !== 'login' && state !== 'challenge') {
            expect(job.title.length).toBeGreaterThan(0);
          }
          const expectedTitle = asString(expected.title);
          if (expectedTitle && expectedTitle.length > 0) {
            expect(normalizeText(job.title)).toBe(normalizeText(expectedTitle));
          }
          const expectedEmployer = asString(expected.employer);
          if (expectedEmployer && expectedEmployer.length > 0) {
            expect(normalizeText(job.employer)).toBe(normalizeText(expectedEmployer));
          }
          if (pageType in EXPECTED_APPLY) {
            const expectedApply = asString(expected.applyType) ?? EXPECTED_APPLY[pageType];
            if (expectedApply && expectedApply !== 'unknown') {
              expect(classifyApplyType(document)).toBe(normalizeApplyType(expectedApply));
            }
          }
          if (pageType === 'job-applied') {
            expect(detectAlreadyApplied(document) || state === 'applied').toBe(true);
          }
          break;
        }

        case 'modal-basic':
        case 'modal-questions': {
          const modalOpen = isApplicationModalOpen(document);
          const dialogCount = document.querySelectorAll(
            '[role="dialog"], [aria-modal="true"], dialog[open]',
          ).length;
          lines.push(`modalOpen: ${modalOpen}`);
          lines.push(`dialogCount: ${dialogCount}`);
          if (expected.hasModal !== false) expect(modalOpen).toBe(true);

          const questions = extractQuestions(document);
          lines.push(`questions: ${questions.length}`);
          for (const question of questions) {
            lines.push(`  - ${question.type}${question.required ? ' *' : ''}: ${question.label}`);
            expect(question.type).not.toBe('unknown');
            expect(question.label.length).toBeGreaterThan(0);
            expect(question.fingerprint.length).toBeGreaterThan(0);
          }

          const labels = questions.map((question) => normalizeText(question.label));
          for (const label of asStringArray(expected.questionLabels).map(normalizeText)) {
            expect(labels).toContain(label);
          }
          for (const label of asStringArray(expected.requiredQuestionLabels).map(normalizeText)) {
            const question = questions.find(
              (candidate) => normalizeText(candidate.label) === label,
            );
            expect(question, `required question ${label}`).toBeDefined();
            if (question) expect(question.required).toBe(true);
          }

          const field = asRecord(expected.documentField);
          if (field) {
            const type = asString(field.type);
            const kind = asString(field.kind);
            lines.push(`documentField: ${type ?? '?'} (${kind ?? '?'})`);
            if (type && kind === 'select') {
              const record = {
                id: asString(field.optionValue) ?? 'doc-1',
                type: type as DocumentType,
                title: asString(field.optionLabel) ?? 'Resume A.pdf',
              };
              const selected = await selectDocument(document, record.type, record);
              lines.push(
                `documentPicker: ${selected.ok ? 'selected' : `FAILED (${selected.error ?? 'unknown'})`}`,
              );
              expect(selected.ok, selected.error ?? 'document picker did not select').toBe(true);
            } else if (type) {
              const picker = document
                .querySelector('[role="dialog"], [aria-modal="true"]')
                ?.querySelector('[role="combobox"], [aria-haspopup], input[placeholder], select');
              lines.push(`documentPicker: ${picker ? `present (${kind ?? 'unknown'})` : 'MISS'}`);
              expect(picker, 'document picker control present').not.toBeNull();
            }
            for (const question of questions) {
              expect(question.label).not.toMatch(/resume|cover letter|transcript/i);
            }
          }
          break;
        }

        case 'my-jobs': {
          const applied = detectAlreadyApplied(document) || detectConfirmation(document).applied;
          lines.push(`appliedSignal: ${applied}`);
          if (expected.hasAppliedText === true) expect(applied).toBe(true);
          break;
        }

        case 'login': {
          const state = detectJobPageState(document);
          const password = document.querySelector('input[type="password"]');
          lines.push(`state: ${state ?? 'none'}`);
          lines.push(`passwordField: ${password !== null}`);
          expect(state === 'login' || password !== null).toBe(true);
          break;
        }

        default: {
          lines.push(...selectorReport(discoverySelectors, document));
          lines.push(...selectorReport(jobSelectors, document));
          lines.push(`jobs: ${extractJobCards(document, host).length}`);
          break;
        }
      }

      logReport(file, lines);
    });
  }
});
