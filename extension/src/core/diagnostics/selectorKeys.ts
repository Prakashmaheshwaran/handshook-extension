import { z } from 'zod';

/** Reviewed adapter identifiers only. Never accept CSS, labels or page text. */
export const SELECTOR_KEYS = [
  'discovery.jobCard',
  'discovery.nextPage',
  'discovery.emptyState',
  'job.title',
  'job.employer',
  'job.description',
  'job.location',
  'job.employmentType',
  'job.salary',
  'job.postedAt',
  'job.challenge',
  'job.login',
  'job.applied',
  'job.closed',
  'job.notOpen',
  'job.applyButton',
  'job.readiness',
  'apply.button',
] as const;

export const STRATEGY_KEYS = [
  'none',
  'role=listitem',
  'role=button',
  'link:href-job-id',
  'css:data-job-id',
  'css:card-hook-anchor',
  'link:data-job-id',
  'css:result-card-hook',
  'css:semantic-list-item',
  'css:card-testid',
  'css:card-aria-title',
  'css:heading',
  'css:title-testid',
  'link:job-anchor',
  'css:card-first-span',
  'css:employer-testid',
  'css:company-link',
  'css:card-paragraph',
  'css:footer-location',
  'css:location-testid',
  'label:definition-location',
  'css:location-class',
  'css:card-meta-employment',
  'css:employment-testid',
  'label:definition-employment',
  'css:card-meta-salary',
  'css:salary-testid',
  'label:definition-salary',
  'css:salary-class',
  'aria:pagination-next',
  'text:next',
  'aria:next-label',
  'css:rel-next',
  'css:results-status',
  'text:no-results',
  'css:empty-testid',
  'text:no-opportunities',
  'css:applied-testid',
  'text:you-applied',
  'text:applied-chip',
  'css:job-details-page',
  'css:h1',
  'css:main-heading',
  'css:employer-link',
  'css:title-sibling',
  'heading:job-description',
  'css:description-testid',
  'css:description-class',
  'css:article',
  'heading:at-a-glance-location',
  'heading:at-a-glance-employment',
  'heading:at-a-glance-salary',
  'css:time-datetime',
  'text:apply',
  'aria:apply-label',
  'css:apply-testid',
  'text:apply-externally',
  'aria:apply-externally',
  'css:external-testid',
  'text:applied-button',
  'text:applied-on-banner',
  'text:withdraw-application',
  'css:closed-testid',
  'text:closed-copy',
  'aria:closed-label',
  'text:not-open-copy',
  'css:not-open-testid',
  'css:challenge-markers',
  'text:challenge-copy',
  'css:login-controls',
  'text:login-heading',
  'css:login-testid',
  'role:job-actions',
  'dom:action-area',
] as const;

/** Exact generic vocabulary only; unknown DOM strings never pass through. */
const ACTION_LABELS = [
  'apply',
  'apply now',
  'apply to job',
  'apply to this job',
  'apply for this job',
  'quick apply',
  'easy apply',
  'apply externally',
  'apply external',
  'external application',
  'applied',
  'save',
  'saved',
  'share',
  'more actions for this job',
] as const;

const outlineCount = z.number().int().min(0).max(1_000_000).catch(0);
const outlineEntrySchema = z.object({
  tag: z
    .enum([
      'main',
      'header',
      'section',
      'div',
      'nav',
      'aside',
      'form',
      'button',
      'a',
      'span',
      'other',
    ])
    .catch('other'),
  role: z
    .enum([
      'button',
      'link',
      'group',
      'toolbar',
      'status',
      'alert',
      'region',
      'main',
      'banner',
      'other',
    ])
    .catch('other')
    .optional(),
  ariaLabel: z.enum(ACTION_LABELS).optional().catch(undefined),
  attributes: z.object({
    'data-kind': z.enum(['button', 'link', '[REDACTED]']).catch('[REDACTED]').optional(),
    'data-variant': z
      .enum(['primary', 'secondary', 'tertiary', '[REDACTED]'])
      .catch('[REDACTED]')
      .optional(),
    'data-hook': z
      .enum(['job-details-page', 'job-actions', '[REDACTED]'])
      .catch('[REDACTED]')
      .optional(),
  }),
  visible: z.boolean(),
  disabled: z.boolean(),
  count: outlineCount,
});

const actionAreaOutlineSchema = z.object({
  version: z.literal(1),
  rootPresent: z.boolean(),
  elementCount: outlineCount,
  buttonCount: outlineCount,
  hiddenButtonCount: outlineCount,
  entries: z.array(outlineEntrySchema).max(64),
});

export type ActionAreaOutline = z.infer<typeof actionAreaOutlineSchema>;

/** Re-project at collection AND persistence/export boundaries, dropping unknown fields. */
export function sanitizeActionAreaOutline(input: unknown): ActionAreaOutline | undefined {
  const result = actionAreaOutlineSchema.safeParse(input);
  if (!result.success) return undefined;
  return {
    ...result.data,
    entries: result.data.entries.map((entry) => {
      // ARIA labels are reviewed only for buttons, never arbitrary page regions.
      const { ariaLabel, ...rest } = entry;
      return (entry.tag === 'button' || entry.role === 'button') && ariaLabel
        ? { ...rest, ariaLabel }
        : rest;
    }),
  };
}

export function parseActionAreaOutline(detail?: string): ActionAreaOutline | undefined {
  if (!detail || detail.length > 20_000) return undefined;
  try {
    return sanitizeActionAreaOutline(JSON.parse(detail));
  } catch {
    return undefined;
  }
}
