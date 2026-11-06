/**
 * Shared paths and helpers for the live Handshake harness.
 *
 * The live profile lives outside the repo (default `~/.handshook-live/profile`) so a
 * single manual login is reused by every worktree. Only one harness may own the
 * profile at a time; `session.json` records the running harness.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
export const BUILD_DIR =
  process.env.HANDSHOOK_LIVE_BUILD ?? path.join(PROJECT_ROOT, '.output', 'chrome-mv3');
export const LIVE_HOME = process.env.HANDSHOOK_LIVE_HOME ?? path.join(homedir(), '.handshook-live');
export const PROFILE_DIR = path.join(LIVE_HOME, 'profile');
export const SESSION_FILE = path.join(LIVE_HOME, 'session.json');
export const LOG_FILE = path.join(LIVE_HOME, 'events.ndjson');
export const SHOTS_DIR = path.join(LIVE_HOME, 'shots');
export const CDP_PORT = Number(process.env.HANDSHOOK_LIVE_CDP_PORT ?? 9333);
export const CONTROL_PORT = Number(process.env.HANDSHOOK_LIVE_CONTROL_PORT ?? 9334);
export const START_URL =
  process.env.HANDSHOOK_LIVE_URL ?? 'https://app.joinhandshake.com/job-search';

export const HANDSHAKE_HOST = /(^|\.)joinhandshake\.(com|co\.uk)$/;

export interface LiveSession {
  readonly pid: number;
  readonly cdpUrl: string;
  readonly controlUrl: string;
  readonly extensionId: string;
  readonly sidePanelUrl: string;
  readonly allowWrites: boolean;
  readonly worktree: string;
  readonly startedAt: string;
}

export function ensureLiveHome(): void {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running harness, or undefined when none is alive. */
export function readSession(): LiveSession | undefined {
  if (!existsSync(SESSION_FILE)) return undefined;
  const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as LiveSession;
  return isAlive(session.pid) ? session : undefined;
}

/** Strip query strings and fragments so tokens never reach logs. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? raw;
  }
}
