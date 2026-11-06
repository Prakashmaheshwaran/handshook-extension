# Wave 0 Launch Packet

Use this immediately after the owner approves [`PLAN.md`](../PLAN.md). Do not start Wave 1 until G1 is green (scaffold + contracts + tests + UI shell).

**Model:** `opencode-go/deepseek-v4.1-flash`
**Workspace:** `extension/`
**Rules:** [`AGENTS.md`](../AGENTS.md) — no live site, no git, no `npm install` outside T01, disjoint files only.

---

## Step 0 — Pre-flight

- [ ] Owner approved scope and decisions in `PLAN.md` §10–11.
- [ ] Working tree clean; integration commits any pending work.
- [ ] No other agent running.
- [ ] Node 20+ and npm available.
- [ ] `.handoffs/` directory exists (gitignored).

---

## Step 1 — T01 only (1 agent)

T01 must finish and be reviewed before anything else starts.

**Prompt:**

```md
You are implementing T01 — Scaffold the extension for the Handshook browser extension.

Read first, in order:

1. extension/AGENTS.md
2. extension/PLAN.md
3. extension/ARCHITECTURE.md
4. extension/docs/CONTRACTS.md (skim for stack expectations)
5. extension/TASKS.md → T01
6. extension/docs/TESTING.md

Scope:
Create the WXT + React + TypeScript strict + Tailwind + Zod + idb extension scaffold in
extension/. Configure MV3 manifest, side panel entrypoint, content script stub, background
stub, lint/test/build configs, and placeholder icons. No product logic.

You own ONLY:

- extension/package.json
- extension/package-lock.json
- extension/wxt.config.ts
- extension/tsconfig.json
- extension/tsconfig.node.json
- extension/eslint.config.js
- extension/.prettierrc
- extension/vitest.config.ts
- extension/playwright.config.ts
- extension/postcss.config.* (if needed)
- extension/src/public/icon-*.png
- extension/src/entrypoints/background.ts
- extension/src/entrypoints/handshake.content.ts
- extension/src/entrypoints/sidepanel/**

Do not edit any other file. Do not touch the Python project.
Do not add feature dependencies beyond WXT, React, TypeScript, Tailwind, Zod, idb,
Vitest, Playwright, ESLint, Prettier, @types/chrome, @types/dom-chromium-ai
(or a local Prompt API type declaration if that package is unavailable).

Manifest requirements:

- permissions: storage, alarms, sidePanel (WXT adds sidePanel from the entrypoint)
- host_permissions: https://_.joinhandshake.com/_, https://joinhandshake.com/_,
  https://_.joinhandshake.co.uk/_, https://joinhandshake.co.uk/_
- optional_host_permissions: https://generativelanguage.googleapis.com/*
- action opens the side panel; no popup
- no cookies, no <all_urls>, no debugger, no remote code

Commands:

- npm install (only you)
- npm run typecheck
- npm run lint
- npm run build
- Verify the build loads in Chromium and the side panel opens.

Rules:

- No live Handshake access.
- No git operations.
- No console.log in production paths.
- Strict TypeScript.
- Write extension/.handoffs/T01.md with versions, commands, folder tree, caveats.

Report: files changed, tests run, build output path, blockers.
```

**Review T01 before proceeding. G1 partial:** build + typecheck + lint + side panel load.

---

## Step 2 — T02, T03, T04 in parallel (3 agents)

Start only after T01 is `done`.

### T02 — Contracts

```md
You are implementing T02 — Frozen contracts.

Read: extension/AGENTS.md, extension/ARCHITECTURE.md, extension/docs/CONTRACTS.md,
extension/TASKS.md → T02.

Implement every schema/type in docs/CONTRACTS.md using Zod, infer TypeScript types,
export defaults/keys/limits, and add parse helpers for UI/content messages, broadcasts,
settings, and settings patches. No feature logic.

You own ONLY:

- extension/src/core/contracts/**
- extension/tests/unit/contracts.test.ts

Do not edit package.json, configs, or other modules.
Commands: npm run typecheck, npm test -- tests/unit/contracts.test.ts, npm run lint.
Write extension/.handoffs/T02.md. Report exported names and any deviation request.
```

### T03 — Test harness

```md
You are implementing T03 — Test harness and mock Handshake skeleton.

Read: extension/AGENTS.md, extension/ARCHITECTURE.md, extension/docs/TESTING.md,
extension/TASKS.md → T03.

Build the Vitest/jsdom/fake-indexeddb setup, test factories, Playwright extension fixture
(bundled Chromium, persistent context, service worker, side panel), Playwright route helper
for https://app.joinhandshake.com/**, and a smoke E2E. No product logic.

You own ONLY:

- extension/src/test/**
- extension/tests/unit/.gitkeep
- extension/tests/integration/.gitkeep
- extension/tests/e2e/helpers/**
- extension/tests/e2e/smoke.spec.ts
- extension/tests/fixtures/shared/**
- extension/scripts/mock-handshake/**
- extension/docs/TESTING.md

Do not add dependencies; do not edit configs (T01 owns them).
Run `npx playwright install chromium` once for the E2E fixture.
Commands: npm test, npm run test:e2e, npm run typecheck, npm run lint.
Write extension/.handoffs/T03.md. Report commands, caveats, fixture conventions.
```

### T04 — UI shell

```md
You are implementing T04 — Design system and side-panel shell.

Read: extension/AGENTS.md, extension/ARCHITECTURE.md §16, extension/TASKS.md → T04.

Build accessible UI primitives, the side-panel shell, a view router (no URL router), and
stub screens at the exact paths T21/T22 will fill. Use mock data only. No storage/business
logic.

You own ONLY:

- extension/src/entrypoints/sidepanel/**
- extension/src/ui/App.tsx
- extension/src/ui/router.ts
- extension/src/ui/theme.css
- extension/src/ui/components/**
- extension/src/ui/hooks/useBridge.ts
- extension/src/ui/screens/** (stubs)

Do not edit package.json, configs, contracts, or background/content.
Commands: npm run typecheck, npm run lint. (Build is integration-owned; do not run it concurrently.)
Write extension/.handoffs/T04.md. Report component API and screen paths.
```

**Review all three.** G1 is green when typecheck/lint/test/build pass, contracts parse, and the side panel shell loads.

---

## Step 3 — T05, T06 in parallel (2 agents)

Start after T02 is `done` (T03/T04 may still be finishing; they don't block T05/T06 if contracts are stable).

### T05 — Background/storage

```md
You are implementing T05 — Background router, storage bootstrap, engine state.

Read: extension/AGENTS.md, extension/ARCHITECTURE.md §2/§6/§7/§15,
extension/docs/CONTRACTS.md, extension/TASKS.md → T05.

Implement the background entry, side-panel behavior, alarms, message router skeleton,
IndexedDB v1 open/migrations, settings repository, engine state repository, and a ping
handler. No engine/queue logic.

You own ONLY:

- extension/src/entrypoints/background.ts
- extension/src/background/router.ts
- extension/src/background/alarms.ts
- extension/src/background/sidePanel.ts
- extension/src/core/storage/db.ts
- extension/src/core/storage/migrations.ts
- extension/src/core/storage/settings.ts
- extension/src/core/state/engineStore.ts
- extension/tests/unit/storage.test.ts

Commands: npm run typecheck, npm test -- tests/unit/storage.test.ts, npm run lint. (Build is integration-owned.)
Write extension/.handoffs/T05.md. Report storage API, alarm names, handler registration.
```

### T06 — Content shell

```md
You are implementing T06 — Content script shell, bridge, SPA lifecycle.

Read: extension/AGENTS.md, extension/ARCHITECTURE.md §2/§15,
extension/docs/CONTRACTS.md, extension/TASKS.md → T06.

Implement the idempotent content entry, typed message bridge with timeouts/cancel, SPA URL
watcher, route classification, and a router stub. No discovery/apply logic.

You own ONLY:

- extension/src/entrypoints/handshake.content.ts
- extension/src/content/bridge.ts
- extension/src/content/lifecycle.ts
- extension/src/content/router.ts
- extension/tests/unit/contentBridge.test.ts

Commands: npm run typecheck, npm test -- tests/unit/contentBridge.test.ts, npm run lint. (Build is integration-owned.)
Write extension/.handoffs/T06.md. Report bridge API, route event shape, handler registration.
```

---

## Step 4 — T07 + T08 (parallel; T07 needs the owner)

### T07 — Live spike

- Agent writes `scripts/capture-page.js` + fixture structure + report template.
- **Owner** runs the capture on the live site using `docs/SPIKE.md` (no submissions).
- Agent sanitizes/analyzes captures, writes `docs/SPIKE-REPORT.md`.
- **G2 gate:** do not start apply-flow tasks until the report is signed off.

### T08 — DOM utilities

```md
You are implementing T08 — DOM utilities, host/URL helpers, selector stubs.

Read: extension/AGENTS.md, extension/docs/SELECTORS.md, extension/docs/CONTRACTS.md,
extension/TASKS.md → T08.

Implement the shared DOM/text/host/health helpers and create stub selector files for each
feature. Tests must cover React native value setting, visibility, text matching, host
parsing, and health thresholds. No feature selectors.

You own ONLY:

- extension/src/handshake/dom.ts
- extension/src/handshake/text.ts
- extension/src/handshake/host.ts
- extension/src/handshake/health.ts
- extension/src/handshake/selectors/index.ts
- extension/src/handshake/selectors/discovery.ts
- extension/src/handshake/selectors/job.ts
- extension/src/handshake/selectors/documents.ts
- extension/src/handshake/selectors/apply.ts
- extension/src/handshake/selectors/questions.ts
- extension/src/handshake/selectors/verification.ts
- extension/tests/unit/dom.test.ts

Commands: npm run typecheck, npm test -- tests/unit/dom.test.ts, npm run lint.
Write extension/.handoffs/T08.md. Report helper API and React caveats.
```

---

## Step 5 — G1/G2 gate review

Before Wave 1:

- [ ] T01–T06 + T08 done; full suite green; build loads.
- [ ] T02 contracts frozen; no feature agent needs a shape change.
- [x] T07 live report signed; selectors are evidence-based, with remaining gaps documented as defensive fallbacks.
- [ ] `TASKS.md` statuses updated; wave handoff written; commit made.
- [ ] Owner approved autopilot/review defaults.

Then, and only then, start Wave 1a.
