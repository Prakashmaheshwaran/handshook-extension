import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findFirstStrategy, resetSelectorHealth } from '@/handshake/health';
import { classifyApplyType, detectJobPageState, extractJobFromDom } from '@/handshake/jobDetails';
import { JOB_PAGE_HOOK, jobSelectors } from '@/handshake/selectors/job';

const HOST = 'app.joinhandshake.com';

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/live/job', name), 'utf8');
}

function load(name: string): void {
  document.body.innerHTML = fixture(name);
}

beforeEach(() => {
  resetSelectorHealth();
  document.body.innerHTML = '';
});

describe('external apply job detail', () => {
  it('extracts every field from the live detail structure', () => {
    load('job-external.html');
    const job = extractJobFromDom(document, HOST, '90000001');

    expect(job).toMatchObject({
      id: '90000001',
      host: HOST,
      title: 'Data Analyst Intern',
      employer: 'Employer A',
      description: 'Build dashboards and analyze marketplace data with a small team.',
      location: 'Onsite, based in Austin, TX',
      employmentType: 'Internship',
      salary: '$25–30/hr',
      applyType: 'external',
      url: 'https://app.joinhandshake.com/jobs/90000001',
    });
  });

  it('matches the verified page hook and apply-externally button', () => {
    load('job-external.html');
    expect(findFirstStrategy(jobSelectors.page, document)).not.toBeNull();

    const external = findFirstStrategy(jobSelectors.externalApplyButton, document);
    expect(external).not.toBeNull();
    expect(external?.getAttribute('aria-label')).toBe('Apply externally');
    expect(classifyApplyType(document)).toBe('external');
  });

  it('is not mistaken for a blocked page state', () => {
    load('job-external.html');
    expect(detectJobPageState(document)).toBeNull();
  });
});

describe('handshake apply job detail', () => {
  it('extracts fields and classifies the plain Apply control', () => {
    load('job-handshake.html');
    const job = extractJobFromDom(document, HOST, '90000002');

    expect(job).toMatchObject({
      title: 'Software Engineer',
      employer: 'Employer B',
      description: 'Design and ship backend services.',
      location: 'Remote',
      employmentType: 'Full-time',
      salary: '$120–140K/yr',
      applyType: 'handshake_form',
    });

    const apply = findFirstStrategy(jobSelectors.applyButton, document);
    expect(apply).not.toBeNull();
    expect(apply?.getAttribute('aria-label')).toBe('Apply');
    expect(findFirstStrategy(jobSelectors.externalApplyButton, document)).toBeNull();
  });

  it('exposes the live detail hook', () => {
    load('job-handshake.html');
    expect(document.querySelector(JOB_PAGE_HOOK)).not.toBeNull();
  });
});

describe('live description section', () => {
  it('returns only the description body, not the section heading', () => {
    load('job-external.html');
    const description = findFirstStrategy(jobSelectors.description, document);
    expect(description?.textContent?.trim()).toBe(
      'Build dashboards and analyze marketplace data with a small team.',
    );
  });
});

describe('live at-a-glance classification', () => {
  it('classifies salary, location and employment without positional assumptions', () => {
    load('job-external.html');
    expect(findFirstStrategy(jobSelectors.salary, document)?.textContent?.trim()).toBe('$25–30/hr');
    expect(findFirstStrategy(jobSelectors.location, document)?.textContent?.trim()).toBe(
      'Onsite, based in Austin, TX',
    );
    expect(findFirstStrategy(jobSelectors.employmentType, document)?.textContent?.trim()).toBe(
      'Internship',
    );
  });

  it('does not read the description as the employer', () => {
    load('job-external.html');
    const employer = findFirstStrategy(jobSelectors.employer, document);
    expect(employer?.textContent?.trim()).toBe('Employer A');
  });
});
