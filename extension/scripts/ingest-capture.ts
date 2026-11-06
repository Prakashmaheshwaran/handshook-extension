/**
 * Ingest sanitized live-capture JSON into fixture files.
 *
 * Usage:
 *   npm run ingest-capture -- ~/Downloads/handshook-capture-*.json
 *   npm run ingest-capture -- path/to/captures-directory
 *
 * For every capture it:
 * 1. re-runs the sanitizer over the HTML and metadata (defense in depth);
 * 2. refuses to write anything if an email, phone, or token pattern survives;
 * 3. writes tests/fixtures/live/<pagetype>/<name>.html + <name>.json;
 * 4. rebuilds that fixture folder's README.md.
 */

/* global process, console */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createSanitizer, findResidualPii } from './capture/sanitize.js';
import type { Sanitizer } from './capture/sanitize.js';

const PAGE_TYPES = [
  'search',
  'job-quick',
  'job-form',
  'job-external',
  'job-applied',
  'job-detail',
  'modal-basic',
  'modal-questions',
  'documents',
  'my-jobs',
  'login',
  'unknown',
] as const;

type PageType = (typeof PAGE_TYPES)[number];

const PAGE_TYPE_SET: ReadonlySet<string> = new Set(PAGE_TYPES);

interface DocumentFieldFact {
  type: string;
  label: string;
  kind: string;
  optionValue: string | null;
  optionLabel: string | null;
}

interface ReadmeEntry {
  file: string;
  capturedAt: string;
  host: string;
  sourceUrl: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}

function collapse(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/`/g, "'");
}

function pathnameOf(value: string): string {
  if (value.length === 0) return '';
  try {
    return new URL(value).pathname.toLowerCase();
  } catch {
    return value.split(/[?#]/)[0]?.toLowerCase() ?? '';
  }
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

function sanitizeString(value: unknown, sanitizer: Sanitizer): string {
  return sanitizer.text(asString(value) ?? '');
}

function deepSanitize(value: unknown, sanitizer: Sanitizer, key = ''): unknown {
  if (typeof value === 'string') {
    const lower = key.toLowerCase();
    if (lower === 'url' || lower === 'sourceurl' || lower === 'href' || lower === 'src') {
      return sanitizer.url(value);
    }
    if (lower === 'resourceurl' || lower === 'networkurl') return sanitizer.resourceUrl(value);
    return sanitizer.text(value);
  }
  if (Array.isArray(value)) return value.map((entry) => deepSanitize(entry, sanitizer, key));
  const record = asRecord(value);
  if (record) {
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(record)) {
      output[childKey] = deepSanitize(child, sanitizer, childKey);
    }
    return output;
  }
  return value;
}

function applyTypeFromDoc(doc: Document): string {
  const names = Array.from(doc.querySelectorAll('button, a, [role="button"]')).map((element) =>
    collapse(element.textContent).toLowerCase(),
  );
  if (
    names.some((name) =>
      /apply externally|apply external|external application|apply on (the )?(company|employer) (site|website)/.test(
        name,
      ),
    )
  ) {
    return 'external';
  }
  if (names.some((name) => /\bquick apply\b/.test(name))) return 'quick_apply';
  if (
    names.some((name) => /^(apply|apply now|apply to job|apply for this job)$/.test(name.trim()))
  ) {
    return 'handshake_form';
  }
  return 'unknown';
}

function inferDocumentType(label: string): string | null {
  if (/cover\s*letter/i.test(label)) return 'cover_letter';
  if (/transcript/i.test(label)) return 'transcript';
  if (/resume|\bcv\b|other\s*document/i.test(label)) return 'resume';
  return null;
}

function documentFieldFromDoc(doc: Document, sanitizer: Sanitizer): DocumentFieldFact | null {
  const root = doc.querySelector('[role="dialog"], [aria-modal="true"]') ?? doc.body;
  for (const labelElement of Array.from(root.querySelectorAll('label, legend, [aria-label]'))) {
    const label = collapse(
      labelElement.textContent ?? labelElement.getAttribute('aria-label') ?? '',
    );
    const type = inferDocumentType(label);
    if (!type || label.length > 160) continue;

    let control: Element | null = null;
    if (labelElement.tagName === 'LABEL') {
      const htmlFor = labelElement.getAttribute('for');
      if (htmlFor) control = doc.getElementById(htmlFor);
    }
    if (!control) {
      const container =
        labelElement.closest('fieldset, section, [role="group"], div') ??
        labelElement.parentElement;
      control =
        container?.querySelector(
          'input, select, textarea, [role="combobox"], button[aria-haspopup]',
        ) ?? null;
    }
    if (!control) continue;

    const tag = control.tagName.toLowerCase();
    const role = control.getAttribute('role');
    const kind =
      tag === 'select'
        ? 'select'
        : role === 'combobox' || control.hasAttribute('aria-haspopup')
          ? 'combobox'
          : tag;
    const fact: DocumentFieldFact = {
      type,
      label: sanitizer.text(label),
      kind,
      optionValue: null,
      optionLabel: null,
    };
    if (tag === 'select') {
      const select = control as HTMLSelectElement;
      const option = Array.from(select.options).find((entry) => entry.value !== '');
      if (option) {
        fact.optionValue = sanitizer.text(option.value);
        fact.optionLabel = sanitizer.text(collapse(option.textContent));
      }
    }
    return fact;
  }
  return null;
}

function expectedFromDoc(
  html: string,
  pageType: PageType,
  capture: Record<string, unknown>,
  parseHtml: (markup: string) => Document,
  sanitizer: Sanitizer,
): Record<string, unknown> {
  const doc = parseHtml(html);
  const summary = asRecord(capture.summary) ?? {};
  const signals = asRecord(capture.signals) ?? {};

  const jobIds = new Set<string>();
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  const cardAnchors = anchors.filter((anchor) =>
    Boolean(
      anchor.closest(
        'article, li, [role="listitem"], [data-job-id], [data-testid*="job" i], [data-testid*="card" i]',
      ),
    ),
  );
  for (const anchor of cardAnchors.length > 0 ? cardAnchors : anchors) {
    const match = /(?:stu\/)?jobs\/(\d{1,20})/.exec(anchor.getAttribute('href') ?? '');
    if (match?.[1]) jobIds.add(match[1]);
  }

  const heading = doc.querySelector('h1');
  const title =
    sanitizer.text(asString(summary.title) ?? '') ||
    sanitizer.text(collapse(heading?.textContent ?? ''));
  const employer =
    sanitizer.text(asString(summary.employer) ?? '') ||
    sanitizer.text(
      collapse(
        doc.querySelector(
          '[data-testid*="employer" i], [data-testid*="company" i], a[href*="/companies/"], a[href*="/employers/"], h1 + p, h1 + span, h1 + div, h1 + a',
        )?.textContent ?? '',
      ),
    );

  const captureQuestions = asArray(
    asRecord(capture.summary)?.questionLabels ?? capture.screeningQuestions,
  )
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      return asString(asRecord(entry)?.label) ?? '';
    })
    .filter((entry) => entry.length > 0)
    .map((entry) => sanitizer.text(entry));
  const questionLabels = asStringArray(summary.questionLabels)
    .map((entry) => sanitizer.text(entry))
    .filter((entry) => entry.length > 0);
  const requiredQuestionLabels = asStringArray(summary.requiredQuestionLabels)
    .map((entry) => sanitizer.text(entry))
    .filter((entry) => entry.length > 0);

  const documentCount =
    asNumber(summary.documentCount) ??
    doc.querySelectorAll('[data-document-id], a[href*="/documents/"], a[href*="/docs/"]').length;

  const bodyText = collapse(doc.body?.textContent ?? '');
  const applyType =
    asString(summary.applyType) && asString(summary.applyType) !== 'unknown'
      ? (asString(summary.applyType) as string)
      : applyTypeFromDoc(doc);
  const urlMatch = /(?:stu\/)?jobs\/(\d{1,20})/.exec(asString(capture.url) ?? '');

  return {
    jobIds: [...jobIds],
    jobIdFromUrl: urlMatch?.[1] ?? null,
    title,
    employer,
    applyType,
    questionLabels: questionLabels.length > 0 ? questionLabels : captureQuestions,
    requiredQuestionLabels,
    documentCount,
    documentTypes: asStringArray(summary.documentTypes).map((entry) => sanitizer.text(entry)),
    documentField: documentFieldFromDoc(doc, sanitizer),
    hasModal: doc.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]') !== null,
    hasAppliedText: /you applied on|already applied|applied on|application submitted/i.test(
      bodyText,
    ),
    login: doc.querySelector('input[type="password"]') !== null,
    pageType,
    questionCount: asNumber(signals.questionCount) ?? questionLabels.length,
  };
}

function domMeta(value: unknown, sanitizer: Sanitizer): Record<string, unknown> {
  const dom = asRecord(value) ?? {};
  const dialogs = asArray(dom.dialogs).map((entry) => {
    const record = asRecord(entry) ?? {};
    return {
      role: asString(record.role),
      ariaModal: asString(record.ariaModal),
      ariaLabel: sanitizeString(record.ariaLabel, sanitizer),
      heading: sanitizeString(record.heading, sanitizer),
      testId: asString(record.testId),
      visible: record.visible === true,
      isPortal: record.isPortal === true,
      controlCount: asNumber(record.controlCount) ?? 0,
    };
  });
  const iframes = asArray(dom.iframes).map((entry) => {
    const record = asRecord(entry) ?? {};
    return {
      src: sanitizer.url(asString(record.src) ?? ''),
      title: sanitizeString(record.title, sanitizer),
      role: asString(record.role),
      visible: record.visible === true,
      accessible: record.accessible === true,
      crossOrigin: record.crossOrigin === true,
      dialogCount: asNumber(record.dialogCount),
      controlCount: asNumber(record.controlCount),
    };
  });
  const shadowRoots = asArray(dom.shadowRoots).map((entry) => {
    const record = asRecord(entry) ?? {};
    return {
      hostTag: asString(record.hostTag),
      hostId: sanitizeString(record.hostId, sanitizer),
      hostClass: sanitizeString(record.hostClass, sanitizer),
      hostTestId: sanitizeString(record.hostTestId, sanitizer),
      childCount: asNumber(record.childCount) ?? 0,
      dialogCount: asNumber(record.dialogCount) ?? 0,
      controlCount: asNumber(record.controlCount) ?? 0,
    };
  });

  return {
    mainSelector: asString(dom.mainSelector),
    dialogCount: asNumber(dom.dialogCount) ?? dialogs.length,
    dialogs,
    portals: dialogs.filter((dialog) => dialog.isPortal),
    iframes,
    shadowRoots,
    appRoots: asStringArray(dom.appRoots).map((entry) => sanitizer.text(entry)),
  };
}

function networkMeta(value: unknown, sanitizer: Sanitizer): Array<Record<string, unknown>> {
  return asArray(value)
    .slice(0, 300)
    .map((entry) => {
      const record = asRecord(entry) ?? {};
      return {
        url: sanitizer.resourceUrl(asString(record.url) ?? ''),
        initiatorType: asString(record.initiatorType) ?? 'other',
        method: null,
      };
    })
    .filter((entry) => typeof entry.url === 'string' && entry.url.length > 0);
}

function normalizePageType(
  rawPageType: string | null,
  capture: Record<string, unknown>,
  sourceUrl: string,
): PageType {
  if (rawPageType && PAGE_TYPE_SET.has(rawPageType)) return rawPageType as PageType;

  const path = pathnameOf(sourceUrl);
  const dom = asRecord(capture.dom) ?? {};
  const signals = asRecord(capture.signals) ?? {};
  const summary = asRecord(capture.summary) ?? {};
  const dialogCount = asNumber(dom.dialogCount) ?? 0;
  const questionCount = asNumber(signals.questionCount) ?? 0;
  const applyType = asString(summary.applyType) ?? 'unknown';

  if (/^\/(?:login|log[-_]?in|signin|sign[-_]?in|sso|auth)(?:\/|$)/.test(path)) return 'login';
  if (/^\/(?:stu\/|profile\/)?documents?(?:\/|$)/.test(path)) return 'documents';
  if (/^\/(?:my[-_]jobs|my[-_]applications|applications|stu\/applications)(?:\/|$)/.test(path)) {
    return 'my-jobs';
  }
  if (
    /^\/(?:job-search|job_search|jobs|jobs\/search|postings|search|stu\/jobs|stu\/search)(?:\/|$)/.test(
      path,
    )
  ) {
    return 'search';
  }
  if (/^\/(?:stu\/)?jobs\/\d+(?:\/|$)/.test(path)) {
    if (dialogCount > 0) return questionCount > 0 ? 'modal-questions' : 'modal-basic';
    if (asString(signals.applyType) === 'external' || applyType === 'external') {
      return 'job-external';
    }
    if (asString(signals.applyType) === 'quick_apply' || applyType === 'quick_apply') {
      return 'job-quick';
    }
    if (asString(signals.applyType) === 'handshake_form' || applyType === 'handshake_form') {
      return 'job-form';
    }
    return 'job-detail';
  }
  if (dialogCount > 0) return questionCount > 0 ? 'modal-questions' : 'modal-basic';
  return 'unknown';
}

function fixtureName(file: string, pageType: PageType, used: Set<string>, dir: string): string {
  let stem = basename(file, '.json')
    .replace(/^handshook-capture-/, '')
    .replace(/-\d{8}(?:-\d{6})?$/, '');
  if (stem === pageType) stem = '';
  else if (stem.startsWith(`${pageType}-`)) stem = stem.slice(pageType.length + 1);
  stem = stem
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  if (stem.length === 0) stem = 'page';

  let candidate = stem;
  let index = 2;
  while (
    used.has(candidate) ||
    existsSync(join(dir, `${candidate}.html`)) ||
    existsSync(join(dir, `${candidate}.json`))
  ) {
    candidate = `${stem}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function listJsonFiles(dir: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...listJsonFiles(child));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) output.push(child);
  }
  return output;
}

function expandInputs(args: readonly string[]): string[] {
  const files: string[] = [];
  for (const arg of args) {
    const target = resolve(arg);
    if (!existsSync(target)) {
      throw new Error(`Input not found: ${arg}`);
    }
    if (statSync(target).isDirectory()) files.push(...listJsonFiles(target));
    else files.push(target);
  }
  return [...new Set(files)].sort();
}

function rebuildReadme(dir: string, pageType: PageType): void {
  const entries: ReadmeEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const fixture = asRecord(asRecord(parsed)?.fixture) ?? {};
      entries.push({
        file: name.replace(/\.json$/i, '.html'),
        capturedAt: asString(fixture.capturedAt) ?? '',
        host: asString(fixture.host) ?? '',
        sourceUrl: asString(fixture.sourceUrl) ?? '',
      });
    } catch {
      /* Ignore unreadable metadata; a later ingest will rebuild the table. */
    }
  }

  const lines = [
    `# ${pageType} live fixtures`,
    '',
    'Sanitized live captures ingested with `npm run ingest-capture`. Never add private',
    'account data, credentials, contact details, or resume contents to this folder.',
    '',
    '| File | Captured | Host | Source URL |',
    '| --- | --- | --- | --- |',
    ...entries.map(
      (entry) =>
        `| \`${escapeCell(entry.file)}\` | ${escapeCell(entry.capturedAt)} | ${escapeCell(entry.host)} | ${escapeCell(entry.sourceUrl)} |`,
    ),
    '',
  ];
  writeFileSync(join(dir, 'README.md'), lines.join('\n'), 'utf8');
}

function printUsage(): void {
  console.log('Usage: npm run ingest-capture -- <capture.json|directory> [...]');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const scriptRoot = dirname(fileURLToPath(import.meta.url));
  const fixturesRoot = process.env.HANDSHOOK_LIVE_FIXTURES
    ? resolve(process.env.HANDSHOOK_LIVE_FIXTURES)
    : resolve(scriptRoot, '../tests/fixtures/live');

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const parseHtml = (markup: string): Document =>
    new dom.window.DOMParser().parseFromString(markup, 'text/html') as unknown as Document;

  const files = expandInputs(args);
  if (files.length === 0) {
    console.log('No capture JSON files found.');
    process.exitCode = 1;
    return;
  }

  const usedNames = new Map<PageType, Set<string>>();
  const touchedFolders = new Set<PageType>();
  const written: string[] = [];
  const failed: string[] = [];

  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const capture = asRecord(parsed);
      if (!capture) throw new Error('Capture JSON must be an object');
      if (asString(capture.tool) !== 'handshook-capture') {
        throw new Error('Not a Handshook capture (missing tool: "handshook-capture")');
      }

      const domRecord = asRecord(capture.dom) ?? {};
      const rawHtml = asString(domRecord.sanitizedHtml) ?? asString(capture.sanitizedHtml) ?? '';
      if (rawHtml.trim().length === 0) throw new Error('Capture has no dom.sanitizedHtml');

      const sanitizer = createSanitizer({ parseHtml });
      const html = sanitizer.html(rawHtml);
      if (html.trim().length === 0) throw new Error('Sanitized HTML is empty');

      const sourceUrl = sanitizer.url(asString(capture.url) ?? '');
      const host = sanitizeString(capture.host, sanitizer) || hostFromUrl(sourceUrl) || 'unknown';
      const pageType = normalizePageType(asString(capture.pageType), capture, sourceUrl);
      const expected = expectedFromDoc(html, pageType, capture, parseHtml, sanitizer);
      const summary = deepSanitize(asRecord(capture.summary) ?? {}, sanitizer);
      const signals = deepSanitize(asRecord(capture.signals) ?? {}, sanitizer);
      const network = networkMeta(capture.network, sanitizer);
      const sanitization = asRecord(capture.sanitization) ?? {};

      const meta = {
        fixture: {
          pageType,
          sourceUrl,
          host,
          title: sanitizeString(capture.title, sanitizer),
          capturedAt: asString(capture.capturedAt),
          ingestedAt: new Date().toISOString(),
          toolVersion: asNumber(capture.version),
          sanitizerVersion: asNumber(sanitization.version),
        },
        expected,
        summary,
        signals,
        dom: domMeta(capture.dom, sanitizer),
        network,
        sanitization: {
          secondPass: true,
          anonymizeEmployers: sanitization.anonymizeEmployers === true,
          redactions: sanitizer.redactions,
          warnings: [...sanitizer.warnings],
          residualFindings: [] as Array<{ kind: string; sample: string }>,
        },
      };

      const findings = [...findResidualPii(html), ...findResidualPii(JSON.stringify(meta))];
      const uniqueFindings = findings.filter(
        (finding, index) =>
          findings.findIndex(
            (other) => other.kind === finding.kind && other.sample === finding.sample,
          ) === index,
      );
      if (uniqueFindings.length > 0) {
        meta.sanitization.residualFindings = uniqueFindings;
        console.error(`FAIL ${file}`);
        for (const finding of uniqueFindings) {
          console.error(`  residual ${finding.kind}: ${finding.sample}`);
        }
        throw new Error('Residual email/phone/token pattern survived sanitization');
      }

      const targetDir = join(fixturesRoot, pageType);
      mkdirSync(targetDir, { recursive: true });
      const used = usedNames.get(pageType) ?? new Set<string>();
      usedNames.set(pageType, used);
      const name = fixtureName(file, pageType, used, targetDir);
      const htmlPath = join(targetDir, `${name}.html`);
      const metaPath = join(targetDir, `${name}.json`);

      writeFileSync(htmlPath, `${html}\n`, 'utf8');
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      touchedFolders.add(pageType);
      written.push(htmlPath);
      console.log(`OK   ${file}`);
      console.log(`  -> ${htmlPath}`);
    } catch (error) {
      failed.push(file);
      console.error(`ERROR ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const pageType of touchedFolders) {
    rebuildReadme(join(fixturesRoot, pageType), pageType);
  }

  console.log('');
  console.log(`Ingested ${written.length} capture(s), failed ${failed.length}.`);
  if (written.length > 0) {
    console.log(`Fixtures: ${fixturesRoot}`);
    console.log('Review the diff and run: npx vitest run tests/integration/live-selectors.test.ts');
  }
  if (failed.length > 0) process.exitCode = 1;
}

await main();
