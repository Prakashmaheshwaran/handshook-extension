/**
 * Background handler for AI page assist.
 *
 * Gate order is fail-closed: the AI setting must be on, then a learned locator
 * is tried, which is local and needs no credentials. Only when that misses does
 * a model call happen — and it needs a configured model, a key, and the explicit
 * OpenRouter permission. Events carry only target, confidence, model and cost —
 * never candidate text.
 */
import { z } from 'zod';
import type { EventLevel, JobEvent } from '@/core/contracts';
import type {
  PageAssistAnswer,
  PageAssistCandidate,
  PageAssistRequest,
  PageAssistTarget,
} from '@/core/contracts/pageAssist';
import { PAGE_ASSIST_TEXT_MAX } from '@/core/contracts/pageAssist';
import { log } from '@/core/logging/logger';
import { getMeta, setMeta } from '@/core/storage/db';
import { loadAiKeys, loadSettings } from '@/core/storage/settings';
import {
  choosePageAssistCandidate,
  PAGE_ASSIST_MIN_CONFIDENCE,
  type PageAssistSelection,
} from '@/ai/page-assist';
import { hasOpenRouterHostPermission } from '@/ai/permissions';

/** Leave headroom inside the content script's 25 s fallback timeout. */
export const PAGE_ASSIST_REQUEST_TIMEOUT_MS = 20_000;
/** At most the three most recent signatures are remembered per target. */
export const PAGE_ASSIST_MAX_LEARNED = 3;
export const PAGE_ASSIST_LEARNED_PREFIX = 'pageAssist.learned';

const learnedSignatureSchema = z.object({
  tag: z.string().min(1).max(32),
  role: z.string().max(32),
  name: z.string().max(PAGE_ASSIST_TEXT_MAX),
  hook: z.string().max(PAGE_ASSIST_TEXT_MAX),
});

const learnedListSchema = z.array(learnedSignatureSchema).max(PAGE_ASSIST_MAX_LEARNED);

type LearnedSignature = z.infer<typeof learnedSignatureSchema>;

const NONE: PageAssistAnswer = { index: null, source: 'none' };

const MESSAGES = {
  'page_assist.learned': 'Page assist matched a learned control',
  'page_assist.ai': 'Page assist selected a control',
  'page_assist.none': 'Page assist found no safe control',
  'page_assist.error': 'Page assist failed',
} as const;

type PageAssistEventType = keyof typeof MESSAGES;

interface PageAssistEventData {
  target: PageAssistTarget;
  confidence?: number;
  model?: string;
  cost?: number;
}

export type PageAssistEmit = (event: JobEvent) => void;

export interface RunPageAssistOptions {
  emit?: PageAssistEmit;
  choose?: typeof choosePageAssistCandidate;
  hasPermission?: () => Promise<boolean>;
}

export function pageAssistLearnedKey(host: string, target: PageAssistTarget): string {
  return `${PAGE_ASSIST_LEARNED_PREFIX}.${host}.${target}`;
}

/** Lowercase, strip punctuation and collapse whitespace for stable matching. */
function normalizeSignatureName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attributeOf(candidate: PageAssistCandidate, name: string): string {
  const attributes = candidate.attributes as Record<string, string | undefined>;
  return attributes[name] ?? '';
}

function signatureOf(candidate: PageAssistCandidate): LearnedSignature {
  return {
    tag: candidate.tag.toLowerCase(),
    role: (candidate.role ?? '').toLowerCase(),
    name: normalizeSignatureName(candidate.name),
    hook: (attributeOf(candidate, 'data-hook') || attributeOf(candidate, 'data-testid')).trim(),
  };
}

function sameSignature(left: LearnedSignature, right: LearnedSignature): boolean {
  return (
    left.tag === right.tag &&
    left.role === right.role &&
    left.name === right.name &&
    left.hook === right.hook
  );
}

async function readLearned(host: string, target: PageAssistTarget): Promise<LearnedSignature[]> {
  try {
    const parsed = learnedListSchema.safeParse(await getMeta(pageAssistLearnedKey(host, target)));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function uniqueLearnedMatch(
  candidates: readonly PageAssistCandidate[],
  learned: readonly LearnedSignature[],
): PageAssistCandidate | undefined {
  for (const signature of learned) {
    const matches = candidates.filter((candidate) =>
      sameSignature(signatureOf(candidate), signature),
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

async function rememberLearned(
  host: string,
  target: PageAssistTarget,
  present: readonly LearnedSignature[],
  picked: PageAssistCandidate,
): Promise<void> {
  const signature = signatureOf(picked);
  const next = [signature, ...present.filter((entry) => !sameSignature(entry, signature))].slice(
    0,
    PAGE_ASSIST_MAX_LEARNED,
  );
  try {
    await setMeta(pageAssistLearnedKey(host, target), next);
  } catch {
    // Learning is an optimisation; storage failures must not break the apply.
  }
}

async function emitPageAssist(
  level: EventLevel,
  type: PageAssistEventType,
  jobId: string,
  data: PageAssistEventData,
  emit?: PageAssistEmit,
): Promise<void> {
  try {
    const event = await log(level, type, MESSAGES[type], { jobId, data: { ...data } });
    emit?.(event);
  } catch {
    // Diagnostics must never break the application path.
  }
}

/**
 * Resolves a page-assist request. Always returns a typed answer and never
 * throws: a provider failure degrades to `{ index: null, source: 'none' }`.
 */
export async function runPageAssist(
  request: PageAssistRequest,
  host: string,
  options: RunPageAssistOptions = {},
): Promise<PageAssistAnswer> {
  const none = (level: EventLevel = 'info'): Promise<PageAssistAnswer> =>
    emitPageAssist(
      level,
      'page_assist.none',
      request.jobId,
      { target: request.target },
      options.emit,
    ).then(() => NONE);

  try {
    const settings = await loadSettings();
    if (!settings.ai.enabled || !settings.ai.pageAssist) return await none('debug');
    // Learned locators are local; only a model call needs a key and permission.
    const learned = await readLearned(host, request.target);
    const learnedHit = uniqueLearnedMatch(request.candidates, learned);
    if (learnedHit) {
      await emitPageAssist(
        'info',
        'page_assist.learned',
        request.jobId,
        { target: request.target, confidence: 1 },
        options.emit,
      );
      return { index: learnedHit.index, source: 'learned', confidence: 1 };
    }

    const model = settings.ai.openRouter.model;
    if (!model) return await none('debug');
    const keys = await loadAiKeys();
    const apiKey = keys.openRouterApiKey?.trim();
    if (!apiKey) return await none('debug');
    if (!(await (options.hasPermission ?? hasOpenRouterHostPermission)()))
      return await none('debug');

    const choose = options.choose ?? choosePageAssistCandidate;
    const selection: PageAssistSelection = await choose(
      { target: request.target, scope: request.scope, candidates: request.candidates },
      { apiKey, settings: settings.ai.openRouter, timeoutMs: PAGE_ASSIST_REQUEST_TIMEOUT_MS },
    );
    const picked =
      selection.index === null
        ? undefined
        : request.candidates.find((candidate) => candidate.index === selection.index);
    if (!picked || selection.confidence < PAGE_ASSIST_MIN_CONFIDENCE) return await none();

    await rememberLearned(host, request.target, learned, picked);
    await emitPageAssist(
      'info',
      'page_assist.ai',
      request.jobId,
      {
        target: request.target,
        confidence: selection.confidence,
        model: selection.model,
        ...(selection.costUsd === undefined ? {} : { cost: selection.costUsd }),
      },
      options.emit,
    );
    return { index: picked.index, source: 'ai', confidence: selection.confidence };
  } catch {
    await emitPageAssist(
      'warn',
      'page_assist.error',
      request.jobId,
      { target: request.target },
      options.emit,
    );
    return NONE;
  }
}
