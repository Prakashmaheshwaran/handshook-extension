import { describe, expect, it } from 'vitest';
import type { MatchInput, ResumeOption } from '@/core/contracts';
import {
  HEURISTIC_WEIGHTS,
  createHeuristicMatcher,
  heuristicMatch,
  scoreResumes,
  tokenizeForMatching,
} from '@/ai/heuristic';

/**
 * The three historical resume profiles from the legacy tool's README
 * (FullStack / AI-ML / Automation), described with generic, PII-free text.
 */
const FULLSTACK: ResumeOption = {
  id: 'resume-fullstack',
  title: 'FullStack Developer',
  description:
    'Software engineering resume focused on React, TypeScript, Node.js, CSS, REST APIs, frontend performance and backend services.',
};

const AIML: ResumeOption = {
  id: 'resume-aiml',
  title: 'AI/ML Engineer',
  description:
    'Machine learning resume covering Python, PyTorch, TensorFlow, NLP, deep learning, data science, feature engineering and model evaluation.',
};

const AUTOMATION: ResumeOption = {
  id: 'resume-automation',
  title: 'Automation Engineer',
  description:
    'Automation resume covering RPA, UiPath, no-code and low-code platforms, workflow automation, bots and repetitive business processes.',
};

const RESUMES: ResumeOption[] = [FULLSTACK, AIML, AUTOMATION];

function makeInput(jobTitle: string, jobDescription: string, resumes = RESUMES): MatchInput {
  return { jobTitle, jobDescription, resumes };
}

const FULLSTACK_JOB = makeInput(
  'Full Stack Software Engineer',
  'Build and maintain web applications with React, TypeScript, Node.js and CSS. Collaborate with backend engineers on REST APIs and improve frontend performance.',
);

const AIML_JOB = makeInput(
  'Machine Learning Engineer',
  'Train and evaluate machine learning models with PyTorch and Python. Work on NLP and deep learning pipelines, feature engineering and model evaluation.',
);

const AUTOMATION_JOB = makeInput(
  'RPA Automation Developer',
  'Build low-code and no-code workflow automation with UiPath, maintain bots and script repetitive business processes.',
);

describe('heuristic matcher picks the historical resume profiles', () => {
  it('picks the full-stack resume for a web engineering role', () => {
    const result = heuristicMatch(FULLSTACK_JOB);

    expect(result.resumeId).toBe(FULLSTACK.id);
    expect(result.provider).toBe('heuristic');
    expect(result.confidence).toBeGreaterThan(0.55);
    expect(result.reason.length).toBeLessThanOrEqual(500);
  });

  it('picks the AI/ML resume for a machine learning role', () => {
    const result = heuristicMatch(AIML_JOB);

    expect(result.resumeId).toBe(AIML.id);
    expect(result.confidence).toBeGreaterThan(0.55);
  });

  it('picks the automation resume for an RPA role', () => {
    const result = heuristicMatch(AUTOMATION_JOB);

    expect(result.resumeId).toBe(AUTOMATION.id);
    expect(result.confidence).toBeGreaterThan(0.55);
  });

  it('ranks the intended profile first in the full score list', () => {
    const ranked = scoreResumes(FULLSTACK_JOB);

    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.resumeId).toBe(FULLSTACK.id);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 1);
  });
});

describe('heuristic weighting', () => {
  it('weights the job title above the job description', () => {
    const input = makeInput(
      'Kubernetes Platform Engineer',
      'Terraform docker aws cloud infrastructure',
      [
        {
          id: 'resume-title',
          title: 'Kubernetes Platform Engineer',
          description: 'Kubernetes platform operations',
        },
        {
          id: 'resume-description',
          title: 'Cloud Infrastructure Engineer',
          description: 'Terraform docker aws cloud infrastructure',
        },
      ],
    );

    const [best] = scoreResumes(input);
    expect(best?.resumeId).toBe('resume-title');
    expect(HEURISTIC_WEIGHTS.title).toBeGreaterThan(HEURISTIC_WEIGHTS.description);
  });

  it('breaks ties on resume id, not input order', () => {
    const duplicateA: ResumeOption = {
      id: 'a-resume',
      title: 'Data Engineer',
      description: 'Python SQL pipelines',
    };
    const duplicateB: ResumeOption = { ...duplicateA, id: 'b-resume' };

    const forward = heuristicMatch(
      makeInput('Data Engineer', 'Python SQL pipelines', [duplicateA, duplicateB]),
    );
    const reversed = heuristicMatch(
      makeInput('Data Engineer', 'Python SQL pipelines', [duplicateB, duplicateA]),
    );

    expect(forward.resumeId).toBe('a-resume');
    expect(reversed.resumeId).toBe('a-resume');
    expect(forward.confidence).toBe(reversed.confidence);
  });

  it('returns a zero-confidence pick when nothing overlaps', () => {
    const result = heuristicMatch(
      makeInput('Barista', 'Serve espresso and clean the counter', RESUMES),
    );

    expect(result.confidence).toBe(0);
    expect(result.reason).toContain('No overlap');
    expect(RESUMES.map((resume) => resume.id)).toContain(result.resumeId);
  });

  it('is deterministic across repeated calls', () => {
    expect(heuristicMatch(FULLSTACK_JOB)).toEqual(heuristicMatch(FULLSTACK_JOB));
    expect(scoreResumes(AIML_JOB)).toEqual(scoreResumes(AIML_JOB));
  });
});

describe('tokenizeForMatching', () => {
  it('splits camelCase and PascalCase names', () => {
    expect(tokenizeForMatching('FullStack Developer')).toContain('full');
    expect(tokenizeForMatching('FullStack Developer')).toContain('stack');
    expect(tokenizeForMatching('UiPath')).toEqual(['ui', 'path']);
  });

  it('splits slashes and hyphens into separate tokens', () => {
    expect(tokenizeForMatching('AI/ML')).toEqual(['ai', 'ml']);
    expect(tokenizeForMatching('low-code automation')).toEqual(['low', 'code', 'automation']);
  });

  it('keeps technology tokens such as node.js and c++', () => {
    expect(tokenizeForMatching('Node.js and C++')).toEqual(['node.js', 'c++']);
  });

  it('drops stop words, single characters and posting boilerplate', () => {
    expect(tokenizeForMatching('The candidate will work with our team')).toEqual([]);
    expect(tokenizeForMatching('a b c')).toEqual([]);
  });
});

describe('heuristic matcher interface', () => {
  it('is always available and never throws on an empty resume list', () => {
    const matcher = createHeuristicMatcher();

    return expect(matcher.availability())
      .resolves.toBe('available')
      .then(() => {
        expect(matcher.id).toBe('heuristic');
        expect(() => heuristicMatch(makeInput('Engineer', 'Text', []))).not.toThrow();
      });
  });

  it('matches through the async interface', async () => {
    const matcher = createHeuristicMatcher();
    const result = await matcher.match(FULLSTACK_JOB);

    expect(result.resumeId).toBe(FULLSTACK.id);
    expect(result.cached).toBe(false);
  });
});
