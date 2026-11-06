/**
 * Live harness: the built extension on the real Handshake site, kept open for agents.
 *
 *   npm run live:login                 # once: headed window, YOU log in, close it
 *   npm run live:start                 # build must exist; keeps running until stopped
 *   npm run live:start -- --build      # run `npm run build` first
 *   npm run live:start -- --allow-writes   # disable the write guard (owner approval only)
 *
 * While running it:
 * - reuses the persistent profile in ~/.handshook-live/profile (your real session)
 * - exposes Chrome DevTools Protocol on 127.0.0.1:9333 (Playwright MCP attaches here)
 * - serves a local control API on 127.0.0.1:9334 (driven by `npm run live -- <cmd>`)
 * - appends page/service-worker console, page errors, and Handshake network
 *   activity to ~/.handshook-live/events.ndjson (URLs without query strings)
 * - blocks application writes to Handshake unless --allow-writes is set
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import {
  chromium,
  type BrowserContext,
  type Page,
  type Request,
  type Worker,
} from '@playwright/test';

import {
  BUILD_DIR,
  CDP_PORT,
  CONTROL_PORT,
  HANDSHAKE_HOST,
  LOG_FILE,
  PROFILE_DIR,
  PROJECT_ROOT,
  SESSION_FILE,
  SHOTS_DIR,
  START_URL,
  ensureLiveHome,
  readSession,
  redactUrl,
  type LiveSession,
} from './common.ts';

const args = new Set(process.argv.slice(2));
const LOGIN_MODE = args.has('--login');
const ALLOW_WRITES = args.has('--allow-writes');
const HEADLESS = args.has('--headless');
const MAX_TEXT = 4_000;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Paths that change application state on Handshake. GraphQL is checked for `mutation`. */
const WRITE_PATH = /appl(y|ication)|submit|withdraw|upload|attachment|document/i;

interface LogEvent {
  readonly t: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

let events: LogEvent[] = [];

function log(kind: string, data: Record<string, unknown>): void {
  const event: LogEvent = { t: new Date().toISOString(), kind, ...data };
  events.push(event);
  if (events.length > 5_000) events = events.slice(-2_500);
  appendFileSync(LOG_FILE, `${JSON.stringify(event)}\n`);
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more]` : text;
}

function isHandshake(raw: string): boolean {
  try {
    return HANDSHAKE_HOST.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

function isApplicationWrite(request: Request): boolean {
  if (!MUTATING.has(request.method())) return false;
  const url = new URL(request.url());
  if (WRITE_PATH.test(url.pathname)) return true;
  if (/graphql/i.test(url.pathname)) return /\bmutation\b/.test(request.postData() ?? '');
  return false;
}

function buildExtension(): void {
  const result = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('npm run build failed');
}

async function launch(): Promise<BrowserContext> {
  if (!existsSync(path.join(BUILD_DIR, 'manifest.json'))) {
    throw new Error(`No build at ${BUILD_DIR}. Run "npm run build" or pass --build.`);
  }
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chromium',
    headless: HEADLESS,
    viewport: null,
    // Keep normal extension lifecycle so `chrome.runtime.reload()` works after rebuilds.
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    args: [
      `--disable-extensions-except=${BUILD_DIR}`,
      `--load-extension=${BUILD_DIR}`,
      '--enable-unsafe-extension-debugging',
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-size=1400,950',
    ],
  });
}

async function extensionWorker(context: BrowserContext): Promise<Worker> {
  const find = (): Worker | undefined =>
    context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
  return (
    find() ??
    (await context.waitForEvent('serviceworker', {
      timeout: 20_000,
      predicate: (worker) => worker.url().startsWith('chrome-extension://'),
    }))
  );
}

async function runLogin(): Promise<void> {
  const context = await launch();
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://app.joinhandshake.com/login');
  console.log(
    '🔐 Log in to Handshake in the opened window, then close the window to save the session.',
  );
  await new Promise<void>((resolve) => context.on('close', () => resolve()));
  console.log(`✅ Session saved in ${PROFILE_DIR}`);
}

function attachPage(page: Page): void {
  page.on('console', (message) => {
    log('console', {
      source: 'page',
      url: redactUrl(page.url()),
      level: message.type(),
      text: truncate(message.text()),
    });
  });
  page.on('pageerror', (error) => {
    log('pageerror', { url: redactUrl(page.url()), text: truncate(error.message) });
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) log('navigate', { url: redactUrl(frame.url()) });
  });
}

function attachWorker(worker: Worker): void {
  // Service-worker console events are only emitted by newer Playwright builds.
  const emitter = worker as unknown as {
    on?: (event: string, listener: (message: { type(): string; text(): string }) => void) => void;
  };
  emitter.on?.('console', (message) => {
    log('console', {
      source: 'service-worker',
      level: message.type(),
      text: truncate(message.text()),
    });
  });
}

async function runHarness(): Promise<void> {
  const running = readSession();
  if (running) {
    throw new Error(
      `A live harness is already running (pid ${running.pid}, worktree ${running.worktree}). ` +
        'Stop it with "npm run live -- stop" or wait for it to finish.',
    );
  }
  if (args.has('--build')) buildExtension();
  ensureLiveHome();

  const context = await launch();
  let worker = await extensionWorker(context);
  let extensionId = new URL(worker.url()).hostname;
  attachWorker(worker);
  context.on('serviceworker', (next) => {
    if (next.url().startsWith('chrome-extension://')) attachWorker(next);
  });

  for (const page of context.pages()) attachPage(page);
  context.on('page', attachPage);

  await context.route(
    (url) => HANDSHAKE_HOST.test(url.hostname),
    async (route) => {
      const request = route.request();
      if (!ALLOW_WRITES && isApplicationWrite(request)) {
        log('blocked-write', { method: request.method(), url: redactUrl(request.url()) });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    },
  );
  context.on('requestfinished', (request) => {
    if (
      !isHandshake(request.url()) ||
      !['document', 'xhr', 'fetch'].includes(request.resourceType())
    )
      return;
    void request.response().then((response) => {
      log('network', {
        method: request.method(),
        type: request.resourceType(),
        url: redactUrl(request.url()),
        status: response?.status() ?? 0,
      });
    });
  });
  context.on('requestfailed', (request) => {
    if (!isHandshake(request.url())) return;
    log('network-failed', {
      method: request.method(),
      url: redactUrl(request.url()),
      error: request.failure()?.errorText ?? 'unknown',
    });
  });

  const pages = (): Page[] => context.pages();
  const sidePanelUrl = (): string => `chrome-extension://${extensionId}/sidepanel.html`;
  const pageFor = (tab: unknown): Page => {
    const list = pages();
    if (tab === undefined || tab === 'last') {
      const last = list.at(-1);
      if (!last) throw new Error('No open tabs');
      return last;
    }
    if (tab === 'sidepanel') {
      const panel = list.find((page) => page.url().startsWith(sidePanelUrl()));
      if (!panel) throw new Error('Side panel tab is not open; run the "sidepanel" command first');
      return panel;
    }
    if (tab === 'handshake') {
      const page = [...list].reverse().find((candidate) => isHandshake(candidate.url()));
      if (!page) throw new Error('No Handshake tab is open');
      return page;
    }
    const page = list[Number(tab)];
    if (!page) throw new Error(`No tab ${String(tab)}; run "tabs"`);
    return page;
  };

  /** `ok`, `login`, `challenge`, or `no-tab` for the most recent Handshake tab. */
  const handshakeState = async (): Promise<string> => {
    const page = [...pages()].reverse().find((candidate) => isHandshake(candidate.url()));
    if (!page) return 'no-tab';
    const url = page.url();
    if (/__cf_chl/.test(url)) return 'challenge';
    const text = await page
      .locator('body')
      .innerText({ timeout: 5_000 })
      .catch(() => '');
    if (/security verification|verify you are human|checking your browser/i.test(text))
      return 'challenge';
    // Handshake's sign-in page now lives at /access ("Log in or sign up").
    if (/\/(login|access)(\/|$|\?)/.test(url)) return 'login';
    return 'ok';
  };

  /** Wait for an extension worker that is not the pre-reload generation. */
  const freshWorker = async (): Promise<Worker> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      for (const candidate of context.serviceWorkers()) {
        if (!candidate.url().startsWith('chrome-extension://')) continue;
        const old = await candidate
          .evaluate('Boolean(self.__handshookOldGeneration)')
          .catch(() => true);
        if (old === false) return candidate;
      }
      // Waking the extension (opening its page) starts the new worker.
      const probe = await context.newPage();
      await probe.goto(sidePanelUrl(), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await probe.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Reloaded extension service worker did not start within 20s');
  };

  const startPage = pages()[0] ?? (await context.newPage());
  await startPage.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch((error: unknown) => {
    log('navigate-error', { text: String(error) });
  });

  const commands: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
    status: async () => ({
      extensionId,
      allowWrites: ALLOW_WRITES,
      cdpUrl: `http://127.0.0.1:${CDP_PORT}`,
      tabs: pages().length,
      handshake: await handshakeState(),
    }),
    tabs: async () => pages().map((page, index) => ({ index, url: page.url(), title: '' })),
    open: async ({ url, tab }) => {
      const page = tab === undefined ? await context.newPage() : pageFor(tab);
      await page.goto(String(url), { waitUntil: 'domcontentloaded' });
      return { index: pages().indexOf(page), url: page.url() };
    },
    sidepanel: async () => {
      const existing = pages().find((page) => page.url().startsWith(sidePanelUrl()));
      const page = existing ?? (await context.newPage());
      if (!existing) await page.goto(sidePanelUrl(), { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      return { index: pages().indexOf(page) };
    },
    front: async ({ tab }) => {
      await pageFor(tab).bringToFront();
      return { ok: true };
    },
    shot: async ({ tab, full }) => {
      const page = pageFor(tab);
      const file = path.join(SHOTS_DIR, `shot-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: full === true });
      return { file };
    },
    snapshot: async ({ tab, selector }) => {
      const page = pageFor(tab);
      return {
        url: page.url(),
        snapshot: await page
          .locator(String(selector ?? 'body'))
          .first()
          .ariaSnapshot(),
      };
    },
    text: async ({ tab, selector }) => {
      const text = await pageFor(tab)
        .locator(String(selector ?? 'body'))
        .first()
        .innerText();
      return { text: truncate(text, MAX_TEXT) };
    },
    click: async ({ tab, selector }) => {
      await pageFor(tab).locator(String(selector)).first().click({ timeout: 10_000 });
      return { ok: true };
    },
    fill: async ({ tab, selector, value }) => {
      await pageFor(tab).locator(String(selector)).first().fill(String(value), { timeout: 10_000 });
      return { ok: true };
    },
    press: async ({ tab, key }) => {
      await pageFor(tab).keyboard.press(String(key));
      return { ok: true };
    },
    wait: async ({ tab, selector, state }) => {
      await pageFor(tab)
        .locator(String(selector))
        .first()
        .waitFor({
          state: (state as 'visible' | 'hidden' | 'attached' | undefined) ?? 'visible',
          timeout: 30_000,
        });
      return { ok: true };
    },
    eval: async ({ tab, expr }) => {
      const source = String(expr);
      const value: unknown =
        tab === 'sw' ? await worker.evaluate(source) : await pageFor(tab).evaluate(source);
      return { value };
    },
    logs: async ({ since, kind, limit }) => {
      const sinceTime = typeof since === 'string' ? since : '';
      const filtered = events.filter(
        (event) => event.t > sinceTime && (kind === undefined || event.kind === kind),
      );
      return { events: filtered.slice(-Number(limit ?? 100)) };
    },
    reload: async ({ build }) => {
      if (build !== false) buildExtension();
      const hadPanel = pages().some((page) => page.url().startsWith('chrome-extension://'));
      await worker.evaluate('self.__handshookOldGeneration = true').catch(() => undefined);
      // Reinstall the unpacked path exactly like an unpacked update; same ID, new generation.
      const browser = context.browser();
      if (!browser) throw new Error('Chromium browser session is unavailable');
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Extensions.loadUnpacked', { path: BUILD_DIR });
      await cdp.detach();
      worker = await freshWorker();
      extensionId = new URL(worker.url()).hostname;
      // Content scripts from the old build are orphaned; reload Handshake and panel tabs.
      for (const page of pages()) {
        if (isHandshake(page.url())) await page.reload({ waitUntil: 'domcontentloaded' });
      }
      // Unloading the extension closes its tabs; reopen the panel if one was open.
      if (hadPanel && !pages().some((page) => page.url().startsWith(sidePanelUrl()))) {
        await commands.sidepanel?.({});
      }
      log('extension-reloaded', { extensionId });
      return { extensionId };
    },
    stop: async () => {
      setTimeout(() => void shutdown(), 50);
      return { stopping: true };
    },
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      void (async () => {
        try {
          const { cmd, ...input } = JSON.parse(body || '{}') as { cmd?: string } & Record<
            string,
            unknown
          >;
          const handler = cmd ? commands[cmd] : undefined;
          if (!handler)
            throw new Error(
              `Unknown command "${String(cmd)}". Known: ${Object.keys(commands).join(', ')}`,
            );
          const result = await handler(input);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      })();
    });
  });
  server.listen(CONTROL_PORT, '127.0.0.1');

  const session: LiveSession = {
    pid: process.pid,
    cdpUrl: `http://127.0.0.1:${CDP_PORT}`,
    controlUrl: `http://127.0.0.1:${CONTROL_PORT}`,
    extensionId,
    sidePanelUrl: sidePanelUrl(),
    allowWrites: ALLOW_WRITES,
    worktree: PROJECT_ROOT,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  log('harness-start', { extensionId, allowWrites: ALLOW_WRITES, worktree: PROJECT_ROOT });

  let closing = false;
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    server.close();
    rmSync(SESSION_FILE, { force: true });
    log('harness-stop', {});
    await context.close().catch(() => undefined);
    process.exit(0);
  }
  context.on('close', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  console.log(`🚀 Live harness ready (extension ${extensionId})`);
  console.log(`   control: ${session.controlUrl}   cdp: ${session.cdpUrl}`);
  console.log(
    `   write guard: ${ALLOW_WRITES ? '⚠️  OFF — real applications can be submitted' : '✅ ON'}`,
  );
}

ensureLiveHome();
await (LOGIN_MODE ? runLogin() : runHarness());
