import { z } from 'zod';
import { jobSchema } from '@/core/contracts';

// Session storage survives MV3 suspension, but clears on browser exit. Tab IDs
// must never be reclaimed across a browser restart, when IDs can be reused.
export const RUNNER_SESSION_KEY = 'handshook.runner.v1';
export const PACING_SESSION_KEY = 'handshook.pacing.v1';

export const runnerSessionSchema = z.object({ tabId: z.number().int().nonnegative().nullable() });
export const pacingSessionSchema = z.object({
  runId: z.string().optional(),
  applications: z.number().int().nonnegative(),
  breakUntil: z.number().finite().nonnegative(),
  scan: z
    .object({
      url: z.string().url(),
      pages: z.number().int().min(0).max(20),
      jobs: z.array(jobSchema).max(1000),
      externalJobs: z.array(jobSchema).max(1000).optional(),
    })
    .optional(),
});

export async function readSession<T>(key: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const area = browser.storage?.session;
  if (!area) return undefined;
  const values = await area.get(key);
  const parsed = schema.safeParse(values[key]);
  return parsed.success ? parsed.data : undefined;
}

export async function writeSession(key: string, value: unknown): Promise<void> {
  await browser.storage?.session?.set({ [key]: value });
}
