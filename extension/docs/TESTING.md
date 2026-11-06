# Testing Strategy

The extension is tested at four layers. No automated test may hit the live Handshake site.

---

## 1. Pyramid

| Layer           | Tool                          | Speed   | What it proves                                                                        |
| --------------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------- |
| Unit            | Vitest                        | ms      | Pure logic: tracker, pacer, filters, matching, validation, redaction                  |
| DOM integration | Vitest + jsdom/happy-dom      | ~100ms  | Selector adapters, React inputs, question detection, document selection               |
| Extension E2E   | Playwright + bundled Chromium | seconds | Side panel + background + content + mock Handshake, full flows                        |
| Live smoke      | Manual, user-owned            | minutes | Real DOM/tenant/network behavior; one review application, optional one safe autopilot |

**Coverage goals:** core logic ≥ 80% lines; adapters ≥ 70%; UI smoke coverage for every screen. Do not chase 100% at the expense of realistic E2E.

---

## 2. Commands

```bash
cd extension
npm test                     # all Vitest
npm run test:unit
npm run test:integration
npm run test:e2e             # mock Playwright; build first, headless by default locally
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run zip                  # WXT ZIP (rebuilds)
npm run package              # validate existing build; ZIP + SHA-256 sidecar
```

Agents run unit/integration for their own files. Integration runs E2E after wiring.

CI pins Node 22.22.2 in both jobs, satisfying the locked dependencies and native
TypeScript script support. `package.json` currently has no `engines` field.

### Time and timezone regression matrix

Run unit and integration tests at real time, just before local midnight, and at
the start of the next year in each timezone:

```bash
for zone in UTC America/Los_Angeles Pacific/Kiritimati; do
  TZ="$zone" npm test -- --maxWorkers 2 || exit 1
  for instant in 2026-12-31T23:59:59.999 2027-01-01T00:00:00.000; do
    TZ="$zone" HANDSHOOK_TEST_SYSTEM_TIME="$instant" npm test -- --maxWorkers 2 || exit 1
  done
done
```

`tests/setup-time.ts` applies the optional date before each test, with an advancing
fake `Date` and real timer callbacks so DOM timeouts and IndexedDB keep working.
Tests that require an exact instant use `vi.useFakeTimers({ toFake: ['Date'] })`
and `vi.setSystemTime`, then restore real timers. Mocking only `Date.now()` does
not change `new Date()`. Use local date constructors when asserting local daily
counters; the tracker regression checks the cap immediately before and after
local midnight, preserving the previous day's count.

---

## 3. Unit tests

### Must cover

- Job/tracker: CRUD, terminal vs retryable, dedup, prune, legacy import mapping.
- Pacer: min/max, jitter bounds, session break, daily reset, unrestricted night-time runs, backoff cap.
- Guards: cap, consecutive failures, auth, rate limit, autopilot gate matrix.
- Queue/engine: transitions, retry limits, pause/resume, crash recovery, no double submit.
- AI: heuristic, cache key, prompt injection, invalid/unknown output, provider fallback.
- AI page assist: candidate schema bounds (80 candidates, 120-char text, allow-listed
  attributes only), no values/answers/URLs in the payload, index validation, learned
  locator reuse, disabled setting/no key → `null`, and the destructive-control vetoes.
- Settings defaults: revision-2 upgrade moves Review to Autopilot, keeps an explicit Dry
  run, preselects the default model, fills the other switches, and preserves later
  user opt-outs; backup import follows the same path.
- Answer matcher: exact/alias/fuzzy, type mismatch, sensitive policy, EEO, free text.
- Filters/scoring: include/exclude, location, remote, unknown fields, explanations.
- Redaction: keys, cookies, tokens, emails, phones; export has no sentinels.
- Contracts: every message parses; malformed rejected; defaults valid.
- URL/host parsing: school hosts, job URLs, pagination, sanitization.

### Rules

- Use factories (`src/test/factories`) — no hand-built giant objects.
- Use fake clock/random for pacing; no real sleeps.
- Mock `fetch`, `chrome.*`; assert no network.
- One behavior per test; name it as a sentence.
- Include at least one failure path per module.

---

## 4. DOM integration tests

Use jsdom/happy-dom for fast adapter tests, with fixtures from `tests/fixtures/synthetic/` and `tests/fixtures/live/`.

### Must cover

- Discovery: both search URL variants, duplicate cards, empty page, next disabled, max pages.
- Job details: Quick/Apply/External labels, applied banner, closed, not-open, API 403/422 fallback.
- Documents: ID/link parsing, search-input, combobox, hidden select, wrong doc, missing required, documents sharing a name.
- Questions: radio, checkbox, select, textarea, number, date, required markers, no-label/aria-label, hidden controls.
- Apply flow: plain Apply opens the dialog, resume card verified/selected, cover-letter
  search picker, submit button found, validation error, unknown question, Review stop,
  confirmation, ambiguous, cancel.
- Page assist fallback: a missing control triggers a candidate query; a safe pick is
  acted on and verified; a vetoed pick (withdraw/delete/upload/cancel/outside dialog),
  a stale apply request, or no candidates falls back to `UI_CHANGED`; a learned locator
  avoids the model call.
- Verification: banner, toast, button change, no confirmation, error.

### React input test

Include a small React component in the test that renders a controlled input and asserts `setNativeValue` updates state (not just the DOM value).

### Fixture rules

- One folder per feature/page; `README.md` with source/date/tenant/sanitization.
- No real PII, tokens, cookies, or resume content.
- Keep fixtures small but preserve labels/roles/attributes.
- Name fixtures by behavior (`modal-with-three-docs.html`), not by date only.

---

## 5. Extension E2E

### Launch recipe

Playwright's bundled Chromium is required; Google Chrome removed side-loading flags.

```ts
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true, // full Chromium supports extensions in headless mode
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
const [sw] = context.serviceWorkers().length
  ? context.serviceWorkers()
  : [await context.waitForEvent('serviceworker')];
const extensionId = new URL(sw.url()).hostname;
```

- Use a fresh profile per test run; remove it before launch.
- Wait for the service worker with a 10–15s timeout on cold start.
- Open the side panel via `chrome-extension://<id>/sidepanel.html`.
- Keep E2E serial (`workers: 1`) to avoid extension state bleed.
- CI explicitly sets `HANDSHOOK_E2E_HEADLESS=1`. For an intentional headed debug
  run, set `HANDSHOOK_E2E_HEADLESS=0` (use xvfb on Linux without a display).
- The list reporter prints progress; the HTML reporter writes
  `playwright-report/index.html`. Failed tests retain traces and screenshots in
  `test-results/`; inspect a trace with `npx playwright show-trace <trace.zip>`.

### Mock Handshake

Use Playwright route interception for `https://app.joinhandshake.com/**` rather than a localhost origin, so content-script match patterns and same-origin semantics are realistic.

Routes to serve:

| Route                         | Variants                                         |
| ----------------------------- | ------------------------------------------------ |
| `GET /job-search*`            | cards, pagination, empty, 10 jobs                |
| `GET /postings*`              | second tenant variant                            |
| `GET /jobs/:id`               | quick, form, external, applied, closed, not open |
| `GET /stu/jobs/:id`           | JSON details, 403, 422                           |
| `GET /my-jobs`                | applied list                                     |
| `POST /jobs/:id/applications` | success, validation error, 429, 403              |
| `GET /login`                  | redirect                                         |

- Set a fake session cookie for realism, but session detection must use DOM.
- Serve a user menu/avatar on authenticated pages.
- Simulate SPA navigation by clicking links rather than full reloads where relevant.
- Simulate a late modal (500ms) and an application modal whose document picker
  offers a fixed option set. Documents are configured by ID/name in settings or in
  the fixture on-boarding step; no server-side document list is fetched.

### Scenarios

**Review opt-out (T31)**

1. Enable **Review before submitting** → onboard → scan → queue 10 jobs → open one with
   2 documents → fill → no submit → user submits → confirmation → applied.
2. Reload mid-queue → state persists → no duplicate.
3. Login redirect → pause → log in → resume.
4. External job → handoff card, no click-through.

**Autopilot (default) (T32)**

1. Start from defaults → plain Apply → dialog → resume/cover letter selected → submit →
   confirm → applied, with no review step.
2. Unknown screening question → needs input → answer → resume.
3. Missing transcript → needs input.
4. Sensitive answer with the switch off → needs input.
5. Daily cap → stop; hard cap cannot be bypassed.
6. 429/403 → backoff/pause.
7. Crash after submit → reconcile → no duplicate.
8. Tab close/restart → paused → resume.
9. Missing selector → page assist off/no key → `UI_CHANGED` pause, no wrong click.
10. Ambiguous confirmation → verifying → reconcile.
11. Missing selector with page assist mocked → AI pick → veto or act-and-verify.

**Review opt-out**

1. `reviewBeforeSubmit: true` → form filled → no submit → user submits → confirmation →
   applied.

**Assertions must be user-visible** (panel text, queue status, confirmation) rather than internal storage where possible. Use `serviceWorker.evaluate` only to seed/read state deliberately.

---

## 6. Live smoke (manual)

See [`SPIKE.md`](./SPIKE.md) and `LIVE-SMOKE.md` (T39). Rules:

- User's own account, normal Chrome profile, unpacked build.
- Review opt-out first: scan 1 page, open 1 Quick Apply job, fill, user submits.
- Then one automated application with the default settings, watched to confirmation.
- No batch autopilot until the single application passes.
- One safe autopilot Quick Apply maximum on the first day.
- Stop on any warning/rate limit; do not retry.
- Record selector misses and timing; sanitize screenshots.
- Never run from CI or by an agent.

---

## 7. CI

`.github/workflows/extension.yml` (T36):

- Path filter: `extension/**` (do not trigger on Python changes).
- npm cache + `npm ci`.
- `typecheck`, `lint`, `format:check`, `test` (unit + integration), `build`, `zip`, `package`.
- Upload `.output/chrome-mv3`, ZIPs, and SHA-256 sidecars.
- **Mandatory mock E2E job on every matching push/PR**, using headless bundled
  Chromium with one worker and no retries. It is not an optional nightly job.
- Upload the HTML report even on failure and `test-results/` on failure for traces
  and screenshots. Missing HTML reports fail the artifact step.
- Packaging checks for forbidden files and embedded credentials. This workflow
  does not run a separate dependency audit; root security workflows are separate.
- Do not modify the existing `.github/workflows/ci.yml`.

---

## 8. Flakiness policy

- No fixed `sleep` in unit/integration tests; use fake clock/`waitFor`.
- E2E waits for conditions, not timeouts.
- Serialize E2E; fresh profile per run.
- If a test is flaky twice, quarantine it with an issue and a task; do not delete it silently.
- Never rerun a failed E2E more than once without investigating.
- CI must not hide failures with `|| true` or `continue-on-error` for required jobs.

---

## 9. What not to test

- Live Handshake selectors in CI.
- AI provider network calls.
- Chrome UI internals.
- Exact CSS classes or DOM structure that another task owns.
- Chrome Web Store review behavior.
- Anti-bot detection (cannot be reliably tested; treat as a risk, not a test).

---

## 10. Release gate

Before T38 signs off:

- [ ] All unit/integration/E2E green.
- [ ] No skipped tests without a linked issue.
- [ ] Fresh-install E2E passes.
- [ ] Upgrade/migration test passes.
- [ ] Redaction/security tests pass.
- [ ] Live smoke completed (T39).
- [ ] Known limitations documented.

### Packaging and store assets

`npm run package` reads `.output/chrome-mv3` without rebuilding, rejects a manifest
version that differs from `package.json`, and writes
`.output/handshook-<version>-chrome.zip` and the adjacent `.zip.sha256` file. It
prints the SHA-256 and a `shasum -a 256 -c` verification command. Regression tests
in `tests/unit/package-tooling.test.ts` exercise the actual CLI with isolated
synthetic builds, including version mismatch and forbidden credential files.

After `npm run build`, use `node scripts/generate-store-assets.ts` for the current
asset pack in `store/` (screenshots, promo, marquee) and icons in `src/public/`.
This uses fictional demo data and local rendering. The obsolete
`store-screenshots.mjs`, which wrote to `docs/store/`, has been removed. Rebuild
after regenerating icons before packaging. Capture tooling for owner-supplied,
sanitized fixtures is documented in `docs/SPIKE.md`; it is separate from mock E2E
and must not be used to contact live Handshake during automated test runs.
