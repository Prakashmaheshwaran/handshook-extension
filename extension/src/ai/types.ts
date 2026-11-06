/**
 * Shared AI matcher types (T13/T14).
 *
 * Contracts in `@/core/contracts` are the single source of truth for the shapes
 * that cross module boundaries (`MatchInput`, `MatchResult`, `ResumeMatcher`,
 * `AiProvider`). This file only adds the internal wiring types the providers and
 * the orchestrator need, plus a typed error so a provider can fail without
 * throwing an untyped value.
 */

import type {
  AiKeys,
  AiAvailability,
  AiProvider,
  AppError,
  ErrorCode,
  MatchInput,
  MatchResult,
  ResumeMatcher,
  Result,
  Settings,
} from '@/core/contracts';
import { appError } from '@/core/contracts';

export type { AiKeys } from '@/core/contracts';

/** Resume-match cache. Implemented over IndexedDB by `@/ai/cache`. */
export interface MatchCache {
  get(key: string): Promise<MatchResult | undefined>;
  put(key: string, result: MatchResult): Promise<void>;
  /** Deletes the oldest entries until at most `limit` remain. Returns the count removed. */
  prune(limit?: number): Promise<number>;
  clear(): Promise<void>;
}

/** Minimal `fetch` shape so tests can inject a mock without touching globals. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One scored resume from the heuristic matcher. */
export interface HeuristicCandidate {
  resumeId: string;
  /** 0..1 weighted blend of the title and description scores. */
  score: number;
  /** 0..1 job-title coverage of this resume's vocabulary. */
  titleScore: number;
  /** 0..1 blend of the two description overlap directions. */
  descriptionScore: number;
}

/**
 * A provider failed. Providers reject with this so the orchestrator can map the
 * failure to an `AppError` without inspecting arbitrary error shapes.
 */
export class AiProviderError extends Error {
  readonly appError: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = 'AiProviderError';
    this.appError = error;
  }
}

/** Builds the typed error a provider rejects with. Messages must be user-safe. */
export function providerError(
  code: ErrorCode,
  message: string,
  options: { retryable?: boolean; cause?: string } = {},
): AiProviderError {
  return new AiProviderError(
    appError(code, message, { retryable: options.retryable ?? false, cause: options.cause }),
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/**
 * Normalises any thrown value into an `AppError`. Aborts become `CANCELLED`;
 * everything else becomes `UNKNOWN` with a redacted, non-throwing message.
 */
export function toAppError(error: unknown, fallbackCode: ErrorCode = 'UNKNOWN'): AppError {
  if (error instanceof AiProviderError) return error.appError;
  if (isAbortError(error)) {
    return appError('CANCELLED', 'Resume matching was cancelled', { retryable: true });
  }
  if (error instanceof Error) {
    return appError(fallbackCode, 'Resume matching failed', { cause: error.message });
  }
  return appError(fallbackCode, 'Resume matching failed');
}

/** Availability of every provider plus the order the orchestrator will try. */
export interface MatcherAvailability {
  heuristic: AiAvailability;
  openRouter: AiAvailability;
  order: AiProvider[];
}

/** Provider dependencies injected by the caller (background worker / tests). */
export interface MatcherDeps {
  settings: Settings;
  keys?: AiKeys;
  fetchImpl?: FetchLike;
  /** `undefined` uses the IndexedDB cache, `null` disables caching. */
  cache?: MatchCache | null;
  openRouter?: ResumeMatcher;
  now?: () => number;
  /** Receives provider failures for structured logging. Never receives secrets. */
  onError?: (error: AppError) => void;
}

/** Orchestrated matcher: never rejects, always returns a `Result`. */
export interface AiMatcher {
  match(input: MatchInput, signal?: AbortSignal): Promise<Result<MatchResult>>;
  availability(): Promise<MatcherAvailability>;
  /** Provider order derived from settings, useful for tests and diagnostics. */
  providerOrder(): AiProvider[];
}
