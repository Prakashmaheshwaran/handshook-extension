import { describe, expect, it } from 'vitest';
import {
  findResidualPii,
  SANITIZER_VERSION,
  classifyPageType,
  createSanitizer,
  sanitizeHtml,
  sanitizeResourceUrl,
  sanitizeUrl,
} from '../../scripts/capture/sanitize.js';

const EMAIL = 'alex.doe@example.test';
const PHONE = '555-123-4567';
const NAME = 'Alex Doe';
const EMPLOYER = 'Acme Robotics';
const RESUME = 'Alex_Doe_Resume.pdf';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const CSRF = 'csrf_token=abcdef1234567890abcdef';

describe('capture sanitizer', () => {
  it('is versioned so fixture metadata can record the sanitizer build', () => {
    expect(SANITIZER_VERSION).toBe(1);
  });

  it('redacts emails and phone numbers in free text', () => {
    const sanitizer = createSanitizer();
    const output = sanitizer.text(`Contact ${EMAIL} or call ${PHONE}.`);

    expect(output).toContain('[email]');
    expect(output).toContain('[phone]');
    expect(output).not.toContain('@');
    expect(output).not.toContain(PHONE);
    expect(sanitizer.redactions.emails).toBe(1);
    expect(sanitizer.redactions.phones).toBe(1);
  });

  it('replaces detected user names, name parts, greetings, and recruiter names', () => {
    const sanitizer = createSanitizer({ userNames: [NAME] });

    expect(sanitizer.text(NAME)).toBe('Student A');
    expect(sanitizer.text('Alex')).toBe('Student A');
    expect(sanitizer.text('Hello, Jordan Blake')).toContain('Student A');
    expect(sanitizer.text('Posted by Taylor Reed')).toContain('[person]');
    expect(sanitizer.text('other people are fine')).toContain('other people are fine');
  });

  it('generalizes resume, cover-letter, and transcript filenames consistently', () => {
    const sanitizer = createSanitizer();
    const output = sanitizer.text(
      `Uploaded ${RESUME}, Cover_Letter.docx, and ${RESUME} again; also transcripts.pdf.`,
    );

    expect(output).toContain('Resume A.pdf');
    expect(output).toContain('Cover Letter A.docx');
    expect(output).toContain('Transcript A.pdf');
    expect(output.match(/Resume A\.pdf/g)).toHaveLength(2);
    expect(output).not.toContain('Alex_Doe');
  });

  it('anonymizes employer names only when explicitly requested', () => {
    const off = createSanitizer({ employerNames: [EMPLOYER] });
    expect(off.text(`${EMPLOYER} is hiring`)).toBe(`${EMPLOYER} is hiring`);

    const on = createSanitizer({ employerNames: [EMPLOYER], anonymizeEmployers: true });
    expect(on.text(`${EMPLOYER} is hiring`)).toBe('Employer A is hiring');
    expect(on.text('Acme Robotics again')).toBe('Employer A again');
    expect(on.redactions.employers).toBe(2);
  });

  it('strips session query parameters while preserving pagination and search terms', () => {
    const output = sanitizeUrl(
      'https://app.joinhandshake.com/job-search?q=engineer&page=2&token=secret123&accessToken=xyz&utm_source=mail&ref=abc#top',
    );

    expect(output).toBe('https://app.joinhandshake.com/job-search?q=engineer&page=2');
    expect(sanitizeUrl('https://app.joinhandshake.com/stu/jobs/123?foo=bar')).toBe(
      'https://app.joinhandshake.com/stu/jobs/123?foo=bar',
    );
  });

  it('redacts PII that appears inside preserved query values', () => {
    const output = sanitizeUrl(
      `https://app.joinhandshake.com/job-search?q=${encodeURIComponent(EMAIL)}&location=${encodeURIComponent(PHONE)}&page=1`,
    );
    const decoded = decodeURIComponent(output);

    expect(decoded).toContain('[email]');
    expect(decoded).toContain('[phone]');
    expect(decoded).not.toContain('example.test');
    expect(decoded).not.toContain(PHONE);
  });

  it('keeps resource endpoint paths and parameter names but drops values and secrets', () => {
    const output = sanitizeResourceUrl(
      'https://app.joinhandshake.com/stu/jobs/123?include=employer&token=secret123&page=2',
    );

    expect(output).toBe('https://app.joinhandshake.com/stu/jobs/123?include=&page=');
    expect(output).not.toContain('secret123');
    expect(output).not.toContain('token');
  });

  it('blocks executable and data URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('[removed-url]');
    expect(sanitizeUrl('data:text/html,<b>x</b>')).toBe('[data-url]');
    expect(sanitizeUrl('#resume')).toBe('#resume');
  });

  it('removes scripts, styles, meta tags, comments, hidden inputs, and inline handlers', () => {
    const output = sanitizeHtml(`
      <meta name="csrf-token" content="secret">
      <style>.x { color: red }</style>
      <script>alert('x')</script>
      <!-- user comment -->
      <div class="card" data-token="secretvalue12345678" data-job-id="1001" style="color:red">
        <h1>Software Engineer</h1>
        <img src="/avatar/42?token=abc" alt="Alex Doe">
        <input type="hidden" name="authenticity_token" value="abc123">
        <input type="text" name="answer" value="private answer">
        <textarea>My cover letter text</textarea>
        <label for="doc">Resume</label>
        <select id="doc"><option value="doc-1">Alex Resume.pdf</option></select>
        <button onclick="steal()">Apply</button>
      </div>
    `);

    expect(output).not.toContain('<script');
    expect(output).not.toContain('<style');
    expect(output).not.toContain('<meta');
    expect(output).not.toContain('type="hidden"');
    expect(output).not.toContain('authenticity_token');
    expect(output).not.toContain('private answer');
    expect(output).not.toContain('My cover letter text');
    expect(output).not.toContain('onclick');
    expect(output).not.toContain('data-token');
    expect(output).not.toContain('secretvalue');
    expect(output).toContain('data-job-id="1001"');
    expect(output).toContain('data-handshook-value-present="true"');
    expect(output).toContain('value="doc-1"');
    expect(output).toContain('Resume A.pdf');
    expect(output).toContain('src="[image]"');
    expect(output).toContain('alt="[avatar]"');
    expect(output).toContain('<label for="doc">Resume</label>');
  });

  it('preserves display:none semantics while removing arbitrary inline styles', () => {
    const output = sanitizeHtml(
      '<div style="display: none; color: red">hidden</div><div style="color: red">visible</div>',
    );

    expect(output).toContain('style="display: none"');
    expect(output.match(/style=/g)).toHaveLength(1);
    expect(output).not.toContain('color: red');
  });

  it('redacts person names in profile and navigation areas without touching job titles', () => {
    const output = sanitizeHtml(
      '<nav><span class="profile-name">Jordan Blake</span></nav><main><h1>Software Engineer Intern</h1></main>',
    );

    expect(output).toContain('Student A');
    expect(output).not.toContain('Jordan Blake');
    expect(output).toContain('Software Engineer Intern');
  });

  it('redacts token-looking option values but keeps document ids', () => {
    const output = sanitizeHtml(
      `<select><option value="doc-123">Resume</option><option value="${JWT}">Weird</option></select>`,
    );

    expect(output).toContain('value="doc-123"');
    expect(output).toContain('value="[token]"');
    expect(output).not.toContain(JWT);
  });

  it('keeps option values on radio groups while dropping typed field values', () => {
    const output = sanitizeHtml(
      '<form><input type="radio" name="answer" value="yes" checked><input type="text" name="secret" value="private"><input type="email" value="alex.doe@example.test"></form>',
    );

    expect(output).toContain('value="yes"');
    expect(output).not.toContain('private');
    expect(output).not.toContain('example.test');
    expect(output).toContain('data-handshook-value-present="true"');
  });

  it('detects planted email, phone, and token patterns and masks the samples', () => {
    const findings = findResidualPii(
      `mail ${EMAIL} phone ${PHONE} jwt ${JWT} ${CSRF} ${'a'.repeat(40)}`,
    );
    const kinds = findings.map((finding) => finding.kind);

    expect(kinds).toContain('email');
    expect(kinds).toContain('phone');
    expect(kinds).toContain('token');
    expect(findings.every((finding) => !finding.sample.includes('@'))).toBe(true);
    expect(findings.every((finding) => !finding.sample.includes('555-123'))).toBe(true);
  });

  it('detects percent-encoded PII and redacts it in URL paths', () => {
    const encoded = encodeURIComponent(EMAIL);
    expect(findResidualPii(encoded).some((finding) => finding.kind === 'email')).toBe(true);
    expect(sanitizeUrl(`https://app.joinhandshake.com/profile/${encoded}`)).toContain('[email]');
  });

  it('produces sanitized HTML with no residual email, phone, or token patterns', () => {
    const sanitizer = createSanitizer({ userNames: [NAME] });
    const output = sanitizer.html(`
      <main>
        <header><span class="profile-name">${NAME}</span></header>
        <p>${EMAIL} ${PHONE} ${NAME} ${RESUME}</p>
        <input type="hidden" name="csrf" value="${CSRF}">
      </main>
    `);

    expect(findResidualPii(output)).toEqual([]);
    expect(output).not.toContain(NAME);
    expect(output).not.toContain('example.test');
    expect(output).not.toContain(PHONE);
  });

  it('is idempotent for already-aliased document filenames', () => {
    const first = sanitizeHtml('<p>Alex Resume.pdf</p>');
    const second = sanitizeHtml(first);

    expect(first).toContain('Resume A.pdf');
    expect(second).toBe(first);
  });

  it('classifies each captured page type from path and DOM signals', () => {
    expect(classifyPageType('/job-search')).toBe('search');
    expect(classifyPageType('/postings?x=1')).toBe('search');
    expect(classifyPageType('/jobs/123', { applyType: 'quick_apply' })).toBe('job-quick');
    expect(classifyPageType('/stu/jobs/123', { applyType: 'handshake_form' })).toBe('job-form');
    expect(classifyPageType('/jobs/123', { applyType: 'external' })).toBe('job-external');
    expect(classifyPageType('/jobs/123', { modal: true })).toBe('modal-basic');
    expect(classifyPageType('/jobs/123', { modal: true, questions: true })).toBe('modal-questions');
    expect(classifyPageType('/profile/documents')).toBe('documents');
    expect(classifyPageType('/my-jobs')).toBe('my-jobs');
    expect(classifyPageType('/login')).toBe('login');
    expect(classifyPageType('/whatever', { jobLinks: 3 })).toBe('search');
    expect(classifyPageType('/whatever')).toBe('unknown');
  });
});
