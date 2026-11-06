# Handshook Extension — Build Plan

**Status:** 1.1.0 hardening integrated; final mock verification and owner release gates tracked in `../docs/hardening/INTEGRATION.md` and `docs/STORE.md`.
**Plan owner:** integration agent (human-approved)
**Implementation model:** frozen contracts, parallel waves, disjoint file ownership, review + integration after each wave

**Historical baseline (1.0.0, 2026-10-25):** the extension, background worker, content adapter, side
panel, legacy import/export, diagnostics, packaging, and headless mock E2E suite are implemented.
Review mode, dry run, opt-in autopilot, manual submit for one-click Quick Apply, review-before-submit
in autopilot, selector health, host selection, and full backup/reset are in the product. Search and
job-detail selectors were verified against sanitized live Handshake DOM (T07); the application
modal, document pickers, My Jobs, and blocked/login states remain defensive fallbacks. Live smoke
(T39) still requires the account owner.
**Default agent model:** `opencode-go/deepseek-v4.1-flash`

---

## 1. What we are building

A Chrome MV3 extension that turns Handshook from a desktop Python automation project into a browser-native assistant.

**Product promise:**

> Install the extension, log in to Handshake normally, pick your resumes, and press Start. Handshook scans your saved searches, ranks the jobs, and applies with the right resume. It only stops when a human decision is genuinely required — and it resumes exactly where it left off.

**Two modes:**

| Mode          | Behavior                                                                                                                     | Default |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Review**    | Pre-fills the application, selects documents, answers known questions, then leaves submission to the user                    | ✅      |
| **Autopilot** | Auto-submits only when the job is a Quick Apply / known form, all documents exist, and every question has an approved answer | Opt-in  |

The extension is a **migration**, not a product rewrite. The Python implementation remains the reference oracle for behavior, endpoints, selectors, rate policy, and edge cases. We delete the desktop plumbing and port the product logic.

---

## 2. Scope

### In scope for v1

- Chrome desktop (MV3), school hosts under `*.joinhandshake.com` and `*.joinhandshake.co.uk`
- Session detection using the existing browser session — no passwords, no cookie extraction
- Onboarding: host/login check, document discovery, reusable answers, search preferences
- Job discovery from live search pages (`/job-search`, `/postings`, and their variants)
- Job details via DOM and the existing `/stu/jobs/{id}` endpoint
- Filters (include/exclude keywords, location, remote, employment type) and fit scoring
- Resume selection: local heuristic by default; optional Chrome Nano → OpenRouter
  with the user's key and selected model → heuristic fallback (1.1.0, ADR-018)
- Document selection: resume, cover letter, transcript, other existing Handshake documents
- Screening-question detection and answer bank (including pause-on-unknown)
- Application flows: Quick Apply, standard Handshake modal, external-apply handoff
- Local tracker/dedup, daily caps, session breaks, backoff, crash recovery
- Side panel UI: onboarding, dashboard, queue, needs-you, activity, settings, diagnostics
- Import from existing `conf.json` / `job_tracker.json` / `rate_stats_*.json`; CSV/JSON export
- Chrome Web Store package + GitHub release ZIP

### Out of scope for v1

- External ATS completion (Workday, Greenhouse, Lever, Ashby, iCIMS)
- File uploads or generated cover-letter PDFs (existing Handshake documents only)
- Backend service, accounts, sync, telemetry
- Firefox, Safari, Chrome Android
- Auto-generated answers to free-text/attestation questions
- Multi-account support
- Bypassing CAPTCHA, Cloudflare, or Handshake rate limits
- Re-implementing Handshake auth/SSO

### Explicit non-goals

- Maximizing applications per day
- "Ban-proof" automation
- Scraping employer/student data beyond what the user's own application flow needs
- Circumventing Handshake's 300/day block or Trust & Safety review

---

## 3. Success criteria

### User experience

- First-run setup completes in **under 3 minutes** without a terminal.
- No Handshake password is ever requested or stored.
- A user can start from a Handshake search page and see a ranked queue without saving HTML.
- Review mode fills a real application correctly, including documents and known screening questions.
- If the browser/tab closes mid-run, reopening resumes without duplicate applications.
- Unknown questions are surfaced with enough context to answer once and reuse.

### Engineering

- `npm run typecheck`, `npm run lint`, `npm test`, and the integration build pass at the end of every wave.
- Core modules (tracker, pacer, answer matching, AI validation, queue) have unit tests.
- Mock-Handshake E2E covers review mode, safe autopilot, unknown question, cap, 429, and crash recovery.
- No live Handshake calls in automated tests.
- Manifest requests only the permissions needed; no `cookies`, no `<all_urls>`, no remote code.
- Bundle target: under 500 KB gzipped for the main extension bundle (excluding icons).
- Selector health is observable; repeated selector failures pause the run instead of silently misfiring.

### Safety

- Default daily cap 25, hard cap 100; 60–120s jitter; 10-application session breaks.
- Autopilot never submits an unanswered attestation, EEO question, or free-text question.
- External-apply jobs are handed off, never clicked through blindly.
- Duplicate submissions are prevented by a write-ahead log + reconciliation.
- No password/cookie/token in storage, logs, fixtures, or exports.

---

## 4. Architecture in one page

```
┌──────────────────────────────────────────────────────────────┐
│ Side panel (React)                                           │
│ Onboarding · Dashboard · Queue · Needs you · Activity ·      │
│ Settings · Diagnostics                                       │
└───────────────────────────┬──────────────────────────────────┘
                            │ typed messages (Zod-validated)
┌───────────────────────────▼──────────────────────────────────┐
│ Background service worker                                    │
│ router · engine state machine · queue · pacer · guards ·     │
│ runner-tab lifecycle · AI proxy · alarms · storage writes    │
└───────────────────────────┬──────────────────────────────────┘
                            │ chrome.tabs / content messages
┌───────────────────────────▼──────────────────────────────────┐
│ Pinned runner tab (joinhandshake.com)                        │
│ content bridge · SPA router · discovery adapter ·            │
│ apply adapter · document selector · question filler ·        │
│ confirmation verifier · selector health                      │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Storage                                                       │
│ chrome.storage.local: settings, engine state, onboarding,     │
│ AI keys (local only)                                          │
│ IndexedDB: jobs, queue, events, answers, documents, aiCache, │
│ submissions, meta                                             │
└──────────────────────────────────────────────────────────────┘
```

**Core design rules:**

1. The long-running loop lives in a **tab content script**, not the MV3 service worker.
2. The extension uses the browser's **existing Handshake session**. No cookies API, no password.
3. **UI-first application** is the default path; internal endpoints are used for details/discovery, not for blind POSTs.
4. **Write-ahead before submit**, verify after, reconcile on restart. Never blind-retry.
5. **Confidence-gated autopilot**: unknown question or missing document → Needs You.
6. **Local-first**: no backend, no telemetry, optional AI only.
7. **Frozen contracts**: shared types and message schemas are defined before parallel work.

Full details: [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`docs/CONTRACTS.md`](./docs/CONTRACTS.md).

---

## 5. Phases and gates

| Phase              | Duration    | Deliverable                                                                                                            | Gate                                                                                                                      |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **0. Foundation**  | 1–1.5 weeks | Scaffold, frozen contracts, test harness, UI shell, background/content shells, live DOM fixtures                       | **G0:** plan approved · **G1:** scaffold + contracts green · **G2:** live spike validates selectors and application types |
| **1. Core engine** | 1.5–2 weeks | Tracker, pacer, queue/state machine, AI, discovery, details, documents, questions, answer bank, runner tab, UI screens | **G3:** unit/integration suites green; modules integrate against mocks                                                    |
| **2. Integration** | 1–1.5 weeks | End-to-end wiring, review-mode E2E, autopilot E2E, legacy import, UX polish, CI, security review, store assets         | **G4:** review-mode E2E passes; one live review application succeeds                                                      |
| **3. Hardening**   | 1 week      | Release candidate, live smoke (review + one safe autopilot), packaging, privacy/store submission                       | **G5:** store candidate signed off                                                                                        |
| **4. Launch**      | ongoing     | Store review, beta feedback, patch releases                                                                            | **G6:** public release                                                                                                    |

**Critical gate — G2:** selector changes must be backed by a fixture in `tests/fixtures/live/` when one exists. The read-only capture record and the procedure for new captures are in [`docs/SPIKE.md`](./docs/SPIKE.md). Selectors that could not be observed live stay defensive fallbacks covered by synthetic fixtures and E2E tests, and are documented as such.

---

## 6. Multi-agent execution model

### 6.1 Workspace rules

Agents work in the **same repository and workspace** in parallel. To avoid merge chaos:

1. **One task per agent** — no agent owns two tasks in the same wave.
2. **Disjoint file ownership** — every task has an explicit `Owns` list. Editing outside it is a failure.
3. **Shared files are locked** — only the scaffold/integration agent edits `package.json`, lockfile, `wxt.config.ts`, `tsconfig`, test configs, `src/entrypoints/*` glue, `src/ui/App.tsx`, `src/core/contracts/**`, `src/core/storage/db.ts`, and `TASKS.md`.
4. **Contracts freeze before Wave 1** — T02 is the only task allowed to define shared types. Changes go through a written change request.
5. **No new dependencies** — all dependencies are chosen in T01. If a task needs one, it stops and reports; integration adds it.
6. **No git operations by agents** — no `git add`, `commit`, `checkout`, `stash`, or branch switching. Integration owns git.
7. **No concurrent `npm install`** — T01 installs; later agents use the existing `node_modules`.
8. **No live Handshake calls from agents** — tests use Playwright route interception and fixtures. Only the user runs live smoke.
9. **No concurrent E2E** — Playwright/Chromium runs are serialized by integration.
10. **Handoff file required** — each agent writes `extension/.handoffs/<TASK_ID>.md` with status, files, tests, blockers, and evidence.

### 6.2 Waves and concurrency

| Wave   | Tasks                        | Max concurrent agents | Purpose                                                |
| ------ | ---------------------------- | --------------------: | ------------------------------------------------------ |
| **0a** | T01                          |                     1 | Scaffold                                               |
| **0b** | T02, T03, T04                |                     3 | Contracts, tests, UI shell                             |
| **0c** | T05, T06                     |                     2 | Background + content shells                            |
| **0d** | T07, T08                     |          2 (one user) | Live DOM capture + DOM utilities                       |
| **1a** | T10, T11, T13, T23, T24, T25 |                     6 | Storage, pacing, AI core, runner tab, logging, filters |
| **1b** | T12, T14, T15, T16, T17, T19 |                     6 | Engine, providers, discovery, details, docs, questions |
| **1c** | T20, T21                     |                     2 | Answer bank + dashboard/queue/activity UI              |
| **1d** | T18, T22                     |                     2 | Apply flow + onboarding/settings/needs-you UI          |
| **2a** | T30                          |                     1 | Integration wiring                                     |
| **2b** | T31–T37                      |                     7 | E2E, import, polish, CI, store, security               |
| **3a** | T38                          |                     1 | Release-candidate hardening                            |
| **3b** | T39, then T40                |              1 + user | Live smoke, then store submission                      |

This is 6–7 agents at peak, not 30 at once. More concurrency than this creates integration and resource contention, not speed. A task starts only when every task in `Depends on` is `done`; the wave labels are capacity groups, not permission to violate dependencies.

**Why not all 35 at once:** every agent edits the same working tree. Disjoint files prevent most conflicts, but contracts, package config, entrypoints, and integration glue are shared. Review bandwidth is also finite: 35 simultaneous diffs cannot be meaningfully reviewed, and a bad contract change would fan out to every task. The wave model keeps 6–7 productive agents while preserving a reviewable change stream.

### 6.3 Handoff and review loop

```
Task agent → writes code + tests + .handoffs/T######.md
           ↓
Wave reviewer (fresh context, same model) → reads diff, runs tests, checks acceptance
           ↓
Integration agent → fixes glue, resolves contract requests, runs full suite, commits
           ↓
Next wave
```

- Reviewers do not fix code (except trivial typos); they return a numbered issue list.
- Failed acceptance → re-run the **same task** once with the issue list; still failing → escalate to a narrower task or integration fix.
- Integration updates `TASKS.md` status and writes a wave summary in `.handoffs/WAVE-<n>.md`.

### 6.4 Agent tiers

All agents use `opencode-go/deepseek-v4.1-flash`. Tier means context budget and review depth, not a different model:

| Tier        | Use for                                                                | Review          |
| ----------- | ---------------------------------------------------------------------- | --------------- |
| **complex** | Contracts, apply flow, state machine, questions, security, integration | Two-pass review |
| **normal**  | Modules, adapters, UI screens, tests                                   | Standard review |
| **simple**  | Docs, icons, CI, packaging                                             | Light review    |

### 6.5 Why this ordering

- **Contracts first** prevents eight agents inventing eight `Job` shapes.
- **DOM utilities + selector stubs first** prevents duplicate selector code.
- **Live fixtures early** prevents agents from guessing Handshake markup.
- **UI shell + screen stubs before screen tasks** prevents `App.tsx` conflicts.
- **Apply flow after documents/questions interfaces exist** keeps the hardest module testable with mocks.
- **Integration before E2E** because E2E needs a wired app.
- **Security review before store packaging sign-off**, not after.

---

## 7. Work breakdown summary

Full task board with acceptance criteria: [`TASKS.md`](./TASKS.md). Machine-readable graph: [`orchestration/tasks.yaml`](./orchestration/tasks.yaml).

| ID  | Task                                           | Wave | Tier    | Depends on         |
| --- | ---------------------------------------------- | ---- | ------- | ------------------ |
| T01 | Scaffold WXT/React/TS/Tailwind/test configs    | 0a   | complex | —                  |
| T02 | Frozen contracts (Zod + TS)                    | 0b   | complex | T01                |
| T03 | Test harness + mock Handshake skeleton         | 0b   | normal  | T01                |
| T04 | Design system + side-panel shell               | 0b   | normal  | T01                |
| T05 | Background router + storage bootstrap          | 0c   | complex | T02                |
| T06 | Content script shell + SPA bridge              | 0c   | normal  | T02                |
| T07 | Live DOM spike + sanitized fixtures            | 0d   | normal  | T06, user          |
| T08 | DOM utilities + selector stubs                 | 0d   | normal  | T02, T06           |
| T10 | Job repository + tracker + dedup               | 1a   | normal  | T02, T05           |
| T11 | Pacer + guardrails                             | 1a   | normal  | T02                |
| T12 | Queue + engine state machine + reconcile       | 1b   | complex | T10, T11           |
| T13 | AI matcher core (heuristic, cache, validation) | 1a   | complex | T02                |
| T14 | AI providers (Nano + OpenRouter BYOK in 1.1.0) | 1b   | normal  | T13                |
| T15 | Discovery adapter                              | 1b   | complex | T08, T10, T07      |
| T16 | Job details + apply-type classification        | 1b   | normal  | T08, T10, T07      |
| T17 | Document discovery + selection                 | 1b   | complex | T08, T07           |
| T18 | Apply flow + confirmation verification         | 1d   | complex | T17, T19, T20, T12 |
| T19 | Screening-question detector                    | 1b   | complex | T08, T07           |
| T20 | Answer bank + matcher                          | 1c   | complex | T02, T19           |
| T21 | Dashboard / Queue / Activity UI                | 1c   | normal  | T04, T05, T12      |
| T22 | Onboarding / Settings / Needs You UI           | 1d   | normal  | T04, T05, T20      |
| T23 | Runner-tab manager + content orchestration     | 1a   | complex | T05, T06           |
| T24 | Logging, redaction, diagnostics core           | 1a   | normal  | T02, T05           |
| T25 | Filters + fit scoring                          | 1a   | normal  | T02                |
| T30 | End-to-end integration wiring                  | 2a   | complex | all Wave 1         |
| T31 | Review-mode E2E                                | 2b   | normal  | T30                |
| T32 | Autopilot + failure E2E                        | 2b   | complex | T30                |
| T33 | Legacy import/export                           | 2b   | normal  | T10, T20           |
| T34 | UX/accessibility polish                        | 2b   | normal  | T21, T22           |
| T35 | Store assets, privacy, packaging               | 2b   | normal  | T01, T21, T22      |
| T36 | Extension CI workflow                          | 2b   | normal  | T01, T03           |
| T37 | Security review + fixes                        | 2b   | complex | T30                |
| T38 | Release-candidate hardening                    | 3a   | complex | all                |
| T39 | Live smoke (user-driven)                       | 3b   | simple  | T38                |
| T40 | Store submission + beta                        | 3b   | simple  | T38, T35, T39      |

---

## 8. Risks and mitigations

| Risk                                        | Likelihood | Impact | Mitigation                                                                             |
| ------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------- |
| Live DOM differs from assumptions           | High       | High   | G2 spike before apply-flow finalization; fixtures; selector health                     |
| Unknown screening questions block autopilot | High       | High   | Answer bank + pause-on-unknown + review mode default                                   |
| External ATS jobs reduce coverage           | High       | Medium | Explicit handoff; do not fake success; measure coverage in spike                       |
| Handshake account restriction               | Medium     | High   | 25/day default, 100 hard cap, jitter, active hours, stop signals, no password          |
| Store rejection / trademark complaint       | Medium     | High   | Transparent listing, own branding, privacy policy, minimal permissions, ZIP fallback   |
| Duplicate applications after crash          | Medium     | High   | Write-ahead + reconcile + idempotency tests                                            |
| MV3 lifecycle/tab throttling                | High       | Medium | Runner tab, alarms, persistence, resume/verify                                         |
| Selector drift after redesign               | High       | Medium | Central adapters, role/text-first selectors, health metrics, quick patch release       |
| AI key leakage / prompt injection           | Medium     | Medium | Local-only storage, allowlist output, no actions from AI, redaction, optional provider |
| Contract drift across agents                | Medium     | High   | Freeze T02, change-request protocol, integration owner                                 |
| Agent file conflicts                        | Medium     | High   | Disjoint ownership, locked files, no git operations, serialized E2E                    |
| Over-engineering v1                         | Medium     | Medium | Non-goals, feature flags, integration gate every wave                                  |

---

## 9. Effort

| Phase                                | Agent-days | Calendar with 6–7 agents |
| ------------------------------------ | ---------: | ------------------------ |
| Foundation                           |         ~8 | 1–1.5 weeks              |
| Core engine                          |        ~21 | 1.5–2 weeks              |
| Integration                          |         ~8 | 1–1.5 weeks              |
| Hardening + store candidate          |         ~3 | 1 week                   |
| Review/integration overhead + buffer |        ~12 | 1 week                   |
| **Total**                            |    **~52** | **5–7 weeks**            |

Solo-equivalent: ~10–12 weeks. The estimate includes review/integration overhead but excludes Chrome Web Store review time (typically days, can be weeks).

---

## 10. Decisions needed before Wave 0

| #   | Decision     | Proposed default                                                                                 |
| --- | ------------ | ------------------------------------------------------------------------------------------------ |
| 1   | v1 mode      | Review-first + opt-in autopilot for Quick Apply and Handshake forms (review stays on by default) |
| 2   | External ATS | Out of scope v1; handoff only                                                                    |
| 3   | Stack        | WXT + React + TypeScript strict + Tailwind + Zod                                                 |
| 4   | Backend      | None in v1; local-first                                                                          |
| 5   | AI           | Heuristic default; optional on-device Nano / OpenRouter with user's key and model                |
| 6   | Distribution | Chrome Web Store + Edge Add-ons + GitHub ZIP                                                     |
| 7   | Browsers     | Chrome/Edge only in v1                                                                           |
| 8   | Python tool  | Keep as legacy/reference; do not share storage                                                   |
| 9   | Live spike   | Owner runs capture on their own account; no agent live access                                    |
| 10  | Data import  | Import `conf.json`, `job_tracker.json`, `rate_stats_*.json`; never cookies/passwords             |

---

## 11. Approval checklist

- [ ] Scope and non-goals confirmed
- [ ] Review-first + autopilot beta accepted
- [ ] Stack and folder layout accepted
- [ ] No-backend/local-first accepted
- [ ] Chrome-only v1 accepted
- [ ] Live spike ownership accepted
- [ ] Wave 0 can start (T01 scaffold)

When approved, start with **T01 only**. Do not spawn Wave 1 until T02 contracts are frozen and G1 is green.
