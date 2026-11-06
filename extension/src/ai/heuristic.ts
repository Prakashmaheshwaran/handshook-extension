/**
 * Deterministic heuristic resume matcher.
 *
 * Always available, no network, no clock. Used as the guaranteed fallback when
 * a cloud provider fails (ARCHITECTURE.md §13: "fall back to heuristic/default
 * resume with low_confidence, not silently to the first resume").
 *
 * Formula:
 *   titleScore       = weighted coverage of the job-title tokens by the resume
 *                      vocabulary (title + description)
 *   descriptionScore = 0.5 * coverage(job description -> resume vocabulary)
 *                    + 0.5 * coverage(resume vocabulary -> job title + description)
 *   score            = 0.60 * titleScore + 0.40 * descriptionScore
 *   confidence       = score + up to 0.15 for the margin over the runner-up
 *
 * Token weight is inverse resume frequency: a word that appears in every resume
 * ("software", "engineer") contributes little; a word unique to one resume
 * ("pytorch", "rpa") contributes a lot. This keeps the pick explainable and
 * stable across resume-list order: ties break on resume id, not input order.
 */

import type { MatchInput, MatchResult, ResumeMatcher, ResumeOption } from '@/core/contracts';
import type { HeuristicCandidate } from '@/ai/types';

export const HEURISTIC_WEIGHTS = {
  title: 0.6,
  description: 0.4,
} as const;

/** Maximum confidence added when the winner clearly beats the runner-up. */
export const MAX_MARGIN_BONUS = 0.15;

const MAX_REASON_CHARS = 200;

const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'candidate',
  'candidates',
  'company',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'job',
  'jobs',
  'just',
  'may',
  'me',
  'might',
  'more',
  'most',
  'must',
  'my',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'position',
  'positions',
  'role',
  'roles',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  // Posting boilerplate: present in almost every listing, never discriminative.
  'ability',
  'across',
  'applicants',
  'application',
  'apply',
  'benefits',
  'education',
  'etc',
  'excellent',
  'experience',
  'including',
  'knowledge',
  'opportunity',
  'plus',
  'preferred',
  'projects',
  'qualifications',
  'required',
  'requirements',
  'responsibilities',
  'resume',
  'skill',
  'skills',
  'strong',
  'team',
  'teams',
  'using',
  'work',
  'working',
  'years',
]);

/**
 * Lower-cases, splits camelCase and PascalCase, then extracts word tokens.
 * "FullStack" -> ["full", "stack"]; "AI/ML" -> ["ai", "ml"]; "Node.js" ->
 * ["node.js"]. Single-character tokens and stop words are dropped.
 */
export function tokenizeForMatching(text: string): string[] {
  const expanded = text
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase();

  const tokens: string[] = [];
  for (const match of expanded.matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu)) {
    const token = match[0].replace(/\.+$/u, '');
    if (token.length < 2) continue;
    if (STOP_WORDS.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

function uniqueTokens(text: string): Set<string> {
  return new Set(tokenizeForMatching(text));
}

function resumeVocabulary(resume: ResumeOption): Set<string> {
  return uniqueTokens(`${resume.title} ${resume.description}`);
}

/** Inverse document frequency over the resumes in the input. */
function tokenWeights(vocabularies: readonly Set<string>[]): (token: string) => number {
  const frequency = new Map<string, number>();
  for (const vocabulary of vocabularies) {
    for (const token of vocabulary) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return (token: string) => {
    const count = frequency.get(token) ?? 0;
    return count === 0 ? 1 : 1 / count;
  };
}

/**
 * Fraction (by weight) of `tokens` that appear in `target`. An empty `tokens`
 * set scores 0: no evidence is not the same as a perfect match.
 */
function weightedCoverage(
  tokens: ReadonlySet<string>,
  target: ReadonlySet<string>,
  weight: (token: string) => number,
): number {
  if (tokens.size === 0) return 0;
  let total = 0;
  let covered = 0;
  for (const token of tokens) {
    const tokenWeight = weight(token);
    total += tokenWeight;
    if (target.has(token)) covered += tokenWeight;
  }
  return total === 0 ? 0 : covered / total;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface ScoredResume {
  resume: ResumeOption;
  candidate: HeuristicCandidate;
}

function scoreResume(
  resume: ResumeOption,
  jobTitleTokens: ReadonlySet<string>,
  jobDescriptionTokens: ReadonlySet<string>,
  jobVocabulary: ReadonlySet<string>,
  weight: (token: string) => number,
): ScoredResume {
  const vocabulary = resumeVocabulary(resume);

  const titleScore = weightedCoverage(jobTitleTokens, vocabulary, weight);
  const jobToResume = weightedCoverage(jobDescriptionTokens, vocabulary, weight);
  const resumeToJob = weightedCoverage(vocabulary, jobVocabulary, weight);
  const descriptionScore = (jobToResume + resumeToJob) / 2;
  const score =
    HEURISTIC_WEIGHTS.title * titleScore + HEURISTIC_WEIGHTS.description * descriptionScore;

  return {
    resume,
    candidate: {
      resumeId: resume.id,
      score: round3(score),
      titleScore: round3(titleScore),
      descriptionScore: round3(descriptionScore),
    },
  };
}

/**
 * Scores every resume, best first. Ties break on resume id so the result does
 * not depend on the order the caller supplied resumes in.
 */
export function scoreResumes(input: MatchInput): HeuristicCandidate[] {
  if (input.resumes.length === 0) return [];

  const jobTitleTokens = uniqueTokens(input.jobTitle);
  const jobDescriptionTokens = uniqueTokens(input.jobDescription);
  const jobVocabulary = new Set([...jobTitleTokens, ...jobDescriptionTokens]);
  const weight = tokenWeights(input.resumes.map(resumeVocabulary));

  return input.resumes
    .map((resume) =>
      scoreResume(resume, jobTitleTokens, jobDescriptionTokens, jobVocabulary, weight),
    )
    .sort(
      (left, right) =>
        right.candidate.score - left.candidate.score ||
        compareIds(left.candidate.resumeId, right.candidate.resumeId),
    )
    .map((scored) => scored.candidate);
}

/** Locale-independent tie-break so results are identical on every machine. */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function percent(value: number): number {
  return Math.round(value * 100);
}

function buildReason(best: HeuristicCandidate): string {
  const title = percent(best.titleScore);
  const description = percent(best.descriptionScore);
  let reason: string;
  if (best.score === 0) {
    reason = 'No overlap between this posting and any resume';
  } else if (best.titleScore >= 0.5) {
    reason = `Strong title match (${title}%) with ${description}% description overlap`;
  } else if (best.descriptionScore >= 0.5) {
    reason = `Description match (${description}%) supports a weaker title match (${title}%)`;
  } else {
    reason = `Weak match (title ${title}%, description ${description}%)`;
  }
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
}

/**
 * Picks the best resume. Confidence is the blend score plus at most
 * `MAX_MARGIN_BONUS` for a clear lead over the runner-up, so a confident pick
 * reads above `settings.ai.minConfidence` while ties stay near the raw score.
 */
export function heuristicMatch(input: MatchInput): MatchResult {
  const candidates = scoreResumes(input);
  const best = candidates[0];
  if (!best) {
    // Callers must handle the empty case before matching (the orchestrator
    // returns INVALID_INPUT). This keeps the function total for direct use.
    return {
      resumeId: '',
      confidence: 0,
      reason: 'No resumes available',
      provider: 'heuristic',
      cached: false,
    };
  }

  const second = candidates[1];
  const margin = second ? Math.max(0, best.score - second.score) : best.score;
  const confidence = round3(clamp01(best.score + MAX_MARGIN_BONUS * margin));

  return {
    resumeId: best.resumeId,
    confidence,
    reason: buildReason(best),
    provider: 'heuristic',
    cached: false,
  };
}

/** `ResumeMatcher` wrapper so the orchestrator can treat every provider alike. */
export function createHeuristicMatcher(): ResumeMatcher {
  return {
    id: 'heuristic',
    availability: () => Promise.resolve('available'),
    match: (input) => Promise.resolve(heuristicMatch(input)),
  };
}
