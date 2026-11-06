/**
 * Fixtures for live specs. They attach to the browser owned by `npm run live:start`
 * instead of launching their own, so they use the real logged-in session and the
 * harness write guard.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { chromium, expect, test as base, type BrowserContext, type Page } from '@playwright/test';

const LIVE_HOME = process.env.HANDSHOOK_LIVE_HOME ?? path.join(homedir(), '.handshook-live');
const SESSION_FILE = path.join(LIVE_HOME, 'session.json');
const LOG_FILE = path.join(LIVE_HOME, 'events.ndjson');

interface LiveSession {
  readonly cdpUrl: string;
  readonly extensionId: string;
  readonly allowWrites: boolean;
}

export interface LiveEvent {
  readonly t: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

function readSession(): LiveSession {
  if (!existsSync(SESSION_FILE)) {
    throw new Error('Live harness is not running. Start it with "npm run live:start".');
  }
  return JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as LiveSession;
}

/** Harness events recorded since `since` (ISO timestamp). */
export function liveEventsSince(since: string): LiveEvent[] {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LiveEvent)
    .filter((event) => event.t >= since);
}

export type LiveState = 'ok' | 'login' | 'challenge';

/** Whether a Handshake page is usable, needs a login, or is a Cloudflare challenge. */
export async function liveState(page: Page): Promise<LiveState> {
  const url = page.url();
  if (/__cf_chl/.test(url)) return 'challenge';
  const text = await page
    .locator('body')
    .innerText({ timeout: 10_000 })
    .catch(() => '');
  if (/security verification|verify you are human|checking your browser/i.test(text))
    return 'challenge';
  // Handshake's sign-in page now lives at /access ("Log in or sign up").
  if (/\/(login|access)(\/|$|\?)/.test(url)) return 'login';
  return 'ok';
}

interface LiveFixtures {
  session: LiveSession;
  context: BrowserContext;
  sidePanel: Page;
  startedAt: string;
}

export const test = base.extend<LiveFixtures>({
  // eslint-disable-next-line no-empty-pattern
  session: async ({}, use) => {
    await use(readSession());
  },
  // eslint-disable-next-line no-empty-pattern
  startedAt: async ({}, use) => {
    await use(new Date().toISOString());
  },
  context: async ({ session }, use) => {
    const browser = await chromium.connectOverCDP(session.cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Live harness has no browser context');
    const opened: Page[] = [];
    context.on('page', (page) => opened.push(page));
    try {
      await use(context);
    } finally {
      // Close only the tabs this test opened; never close the harness browser.
      for (const page of opened) if (!page.isClosed()) await page.close();
    }
  },
  sidePanel: async ({ context, session }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${session.extensionId}/sidepanel.html`);
    await use(page);
  },
});

export { expect };
