/**
 * Zod schemas for shapes that do not have a frozen contract schema:
 * persisted documents and queue items (used by backup import and export).
 * Unknown keys are stripped by Zod, which guarantees exports never carry
 * fields the extension did not choose.
 */

import { z } from 'zod';
import { appErrorSchema } from '@/core/contracts';

/** Every supported legacy file is a JSON object at the top level. */
export const legacyJsonObjectSchema = z.record(z.string(), z.unknown());

export const legacyResumeSchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  title: z.union([z.string(), z.number(), z.null()]).optional(),
  description: z.union([z.string(), z.number(), z.null()]).optional(),
});

/** Profiles changed shape over time; treat known fields as untrusted unknowns. */
export const legacyProfileSchema = z.record(z.string(), z.unknown());

/** `RATE_LIMIT_CONFIG` must be an object; individual values are coerced later. */
export const legacyRateLimitSchema = z.record(z.string(), z.unknown());

/** One tracker entry. Non-objects are reported and imported without metadata. */
export const legacyTrackerInfoSchema = z.record(z.string(), z.unknown());

const numberLike = z.union([z.number(), z.string()]);

export const legacyRateStatsSchema = z.object({
  daily_counts: z.record(z.string(), numberLike),
  total_applications: numberLike.optional(),
});

export const legacyDocumentSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['resume', 'cover_letter', 'transcript', 'other']),
  title: z.string(),
  filename: z.string().optional(),
  description: z.string().optional(),
  updatedAt: z.string().optional(),
  uploadedAt: z.string().optional(),
  ready: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

const jobStatusSchema = z.enum([
  'discovered',
  'filtered',
  'queued',
  'opening',
  'filling',
  'ready_for_review',
  'submitting',
  'verifying',
  'applied',
  'external',
  'needs_input',
  'waiting',
  'already_applied',
  'skipped',
  'failed',
  'blocked',
]);

const documentTypeSchema = z.enum(['resume', 'cover_letter', 'transcript', 'other']);

export const legacyQueueItemSchema = z.object({
  jobId: z.string().min(1),
  status: jobStatusSchema,
  priority: z.number(),
  attempts: z.number(),
  addedAt: z.number(),
  updatedAt: z.number(),
  nextAttemptAt: z.number().optional(),
  lastError: appErrorSchema.optional(),
  skipReason: z.string().optional(),
  pendingQuestionIds: z.array(z.string()).optional(),
  missingDocumentTypes: z.array(documentTypeSchema).optional(),
  submissionAttemptId: z.string().optional(),
  runId: z.string().optional(),
});

export type LegacyDocument = z.infer<typeof legacyDocumentSchema>;
export type LegacyQueueItem = z.infer<typeof legacyQueueItemSchema>;
