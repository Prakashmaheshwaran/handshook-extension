# Rules for Implementation Agents

**Read this before touching any file.** You are one worker in a parallel build. Your job is a single task, inside a fixed file boundary, with tests and a handoff. The integration agent owns the repo, git, shared files, and final wiring.

---

## 1. Read order

1. `extension/AGENTS.md` (this file)
2. `extension/PLAN.md`
3. `extension/ARCHITECTURE.md`
4. `extension/docs/CONTRACTS.md`
5. Your task in `extension/TASKS.md`
6. `extension/docs/PORT-NOTES.md` if your task says "port" or "preserve behavior"
7. The relevant source files named in `Owns`/`Depends`
8. `extension/docs/TESTING.md` and `extension/docs/SELECTORS.md` if your task touches DOM or tests

Do not ask for a full repo dump. Your brief names the files you need.

---

## 2. Non-negotiables

| Rule                                                                                                                                                                                         | Consequence                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Do not touch the live Handshake site.** No logins, no scans, no applications, no manual testing on `joinhandshake.com`.                                                                    | Account risk and ToS violation. Tests use fixtures/mocks only.                                                                                                                       |
| **Do not edit outside your `Owns` list.**                                                                                                                                                    | Parallel agents will conflict. Stop and report if you need a shared change.                                                                                                          |
| **Do not edit shared files:** `package.json`, lockfile, `wxt.config.ts`, `tsconfig*`, test configs, `src/core/contracts/**`, `src/core/storage/db.ts`, `TASKS.md`, `src/entrypoints/*` glue. | Integration owns them. Use a change request.                                                                                                                                         |
| **Do not add dependencies.**                                                                                                                                                                 | All dependencies are chosen in T01. Report the need instead.                                                                                                                         |
| **Do not run git commands.** No add/commit/checkout/stash/branch.                                                                                                                            | Integration owns git.                                                                                                                                                                |
| **Do not run `npm install`.**                                                                                                                                                                | Concurrency corrupts the lockfile. `node_modules` already exists.                                                                                                                    |
| **Do not run `npm run dev`, `npm run build`, or E2E concurrently with other agents.**                                                                                                        | Chromium/port/output conflicts. T01, T03, T30, and T38 are the only build owners. Feature agents use `npm run typecheck` + targeted tests; integration runs the authoritative build. |
| **No secrets, passwords, cookies, tokens, real names, emails, or resume content in code, fixtures, logs, or handoffs.**                                                                      | Security and privacy. Use sanitized fixtures.                                                                                                                                        |
| **No remote code, `eval`, `new Function`, or remote scripts.**                                                                                                                               | Store policy + security.                                                                                                                                                             |
| **No `innerHTML` with job/page content.** Use React text rendering or `textContent`.                                                                                                         | XSS.                                                                                                                                                                                 |
| **No telemetry/network calls except the AI provider under an explicit user setting.**                                                                                                        | Privacy.                                                                                                                                                                             |
| **No `console.log` in production paths.** Use the structured logger.                                                                                                                         | Diagnostics quality.                                                                                                                                                                 |
| **Do not change contracts silently.**                                                                                                                                                        | Contract drift breaks parallel work.                                                                                                                                                 |

If a rule blocks your task, stop and write the blocker in your handoff. Do not work around it by editing shared files.

---

## 3. Code standards

### TypeScript

- `strict` on. No `any`. Prefer `unknown` + Zod parsing at boundaries.
- No non-null assertions (`!`) unless provably safe and commented.
- Use `Result<T>`/`AppError` for expected failures; throw only for programmer invariants.
- Export types from contracts, not ad-hoc duplicates.
- Use `readonly` for immutable data where practical.
- Prefer pure functions in `core/`; keep DOM/browser calls in adapters.
- Use `crypto.randomUUID()` for IDs; `sha256` helper for fingerprints/cache keys.
- No date libraries; use `Intl`/`Date` and the injectable clock.
- Use WXT's `browser` API, not the global `chrome` object, so a future Firefox port is possible. (`chrome.*` is only acceptable in a clearly marked Chrome-only fallback.)

### Naming

- Files: `kebab-case` for utilities, `PascalCase.tsx` for components/screens.
- Types/interfaces: `PascalCase`; functions/variables: `camelCase`; constants: `UPPER_SNAKE_CASE`.
- Message types: `ui.*`, `content.*`, `content.event.*`, `state.*`.
- Error codes: `UPPER_SNAKE_CASE` from contracts.

### Modules

- `core/` must not import `handshake/`, `ui/`, or `content/`.
- `handshake/` may import `core/contracts`, `core/util`, `core/storage` repositories (not raw `db.ts`).
- `ui/` may import contracts and send messages; no direct IndexedDB/browser automation.
- `content/` may import `handshake/` adapters and `core/contracts`; no direct settings writes.
- `background/` wires everything; no DOM.
- Avoid circular imports. If two modules need each other, move the shared type to contracts.

### React / UI

- Function components; no class components.
- Controlled inputs; labels tied to inputs; errors announced.
- No remote fonts/assets; system font stack.
- Use the T04 design primitives; don't create a parallel design system.
- Every async action has loading/disabled/error state.
- No business logic in components; use hooks/commands.

### DOM adapters

- Never guess a selector when a fixture can verify it. Add sanitized live fixtures under `tests/fixtures/live/`; document any selector that is only a defensive fallback.
- Prefer accessible roles/labels/text over CSS classes.
- Every strategy reports selector health.
- Use `setNativeValue` for React inputs; dispatch `input` and `change`.
- Use `click()` after scroll; never dispatch a synthetic submit that bypasses app validation.
- Wait for a positive condition, not a fixed sleep (except the human pacing deliberately).
- Cancel must abort waits and leave the page usable.
- Never submit unless the caller's gate allows it.
- Never auto-answer a sensitive question.

### Tests

- Unit tests for pure logic; DOM integration tests for adapters.
- Test names describe behavior, not implementation.
- Use factories, not hand-built objects.
- No live network. Mock `fetch`, `LanguageModel`, and `chrome.*`.
- Use fake clock/random for pacing.
- Add at least one negative/error test per module.
- Do not lower coverage or skip tests to make a build pass.
- Do not test implementation details that will change in another task.

### Logging

- Structured `JobEvent` only; redact at the source.
- No `console.log`, `console.warn`, or `console.error` in shipped code.
- Include `jobId`/`phase` context when available.
- Never log full descriptions, resume text, answers, keys, cookies, or URLs containing tokens.

---

## 4. File ownership protocol

1. **Before editing**, list your allowed paths from `TASKS.md`.
2. If you need a change in a shared file:
   - stop;
   - write the exact proposed diff/interface in `.handoffs/<TASK_ID>.md`;
   - message integration (or leave the handoff if async);
   - continue only with the parts that don't need the change.
3. If you discover another agent's file is wrong:
   - do not edit it;
   - add a numbered issue to your handoff;
   - integration routes it.
4. If you need a new fixture folder, create it under your feature name (`tests/fixtures/<feature>/`), not the shared root.
5. If you need a new dependency, propose it with size/maintenance/license/security notes. Integration decides.

---

## 5. Commands

```bash
cd extension

npm run typecheck                 # required before handoff
npm run lint                      # required before handoff
npm test -- tests/unit/<file>.test.ts
npm test -- tests/integration/<file>.test.ts
npm run build                     # only T01, T03, T30, T38 — not feature agents
```

Do **not** run:

- `npm install`
- `npm run dev`
- `npm run test:e2e` (integration serializes it)
- `npm run format` over the whole repo (use `npx prettier --check <your files>`)

If a command fails for reasons outside your task, report it; do not fix unrelated files.

**Parallel typecheck/build caveat:** other agents may be mid-write in disjoint files. If `npm run typecheck`, `npm run lint`, or `npm run build` fails **only** in files outside your `Owns`, record it as a transient cross-task failure, run your own tests, and note it in the handoff. Do not edit another task's files to make the repo green. Integration runs the authoritative full-suite check at the end of the wave.

---

## 6. Handoff file

Every task ends with `extension/.handoffs/<TASK_ID>.md`:

```md
# T## — <task title>

Status: done | blocked | partial
Agent: <name/model>
Started/ended: <ISO timestamps>

## What changed

- path — one line

## Tests run

- command — pass/fail
- command — pass/fail

## Decisions

- what/why (link to architecture/contracts)

## Deviations

- any contract/architecture deviation, with proposed fix

## Blockers / requests

- shared-file change requests
- missing fixtures
- follow-up tasks

## Evidence

- fixture names, screenshots (sanitized), key test names
```

Keep it short. Do not paste full diffs.

---

## 7. Task brief template

Copy this into the agent prompt:

```md
You are implementing <TASK_ID> — <task title> for the Handshook browser extension.

Read first, in order:

1. extension/AGENTS.md
2. extension/PLAN.md
3. extension/ARCHITECTURE.md (sections relevant to your task)
4. extension/docs/CONTRACTS.md
5. extension/TASKS.md → <TASK_ID>
6. extension/docs/PORT-NOTES.md if your task says "port" or "preserve behavior"
7. extension/docs/TESTING.md and extension/docs/SELECTORS.md if relevant

Scope:
<one paragraph>

You own ONLY these paths:

- <path>
- <path>

Do not edit any other file. Specifically do not touch package.json, package-lock.json,
wxt.config.ts, tsconfig*, test configs, src/core/contracts/**, src/core/storage/db.ts,
TASKS.md, src/entrypoints/* glue, or another task's files.

Dependencies already implemented:

- <task id + API>

Deliverable:

- <what exists at the end>

Acceptance criteria:

- <copied from TASKS.md>

Commands:

- npm run typecheck
- npm test -- <your test path>
- npm run lint
- npm run build (only if your task is a designated build owner)

Rules:

- No live Handshake access; fixtures/mocks only.
- No new dependencies.
- No git operations, no npm install, no dev server.
- Strict TypeScript, no any, no console.log.
- Redact secrets/PII.
- Stop and write a change request if a contract/shared file must change.

At the end write extension/.handoffs/<TASK_ID>.md using the template in AGENTS.md.
Report: files changed, tests run, decisions, blockers.
```

---

## 8. Review checklist (for review agents)

Do not fix code. Return a numbered list with severity.

- [ ] Scope: only `Owns` files changed.
- [ ] Contracts: imports from `src/core/contracts`, no duplicate shapes.
- [ ] No live calls/secrets/PII in code, fixtures, logs.
- [ ] Strict types; no `any`/`@ts-ignore` without justification.
- [ ] Error paths typed; no raw throws across boundaries.
- [ ] Tests cover the acceptance criteria and at least one failure path.
- [ ] No `console.*`; structured logging.
- [ ] No `innerHTML` with untrusted content.
- [ ] React inputs use native setter/events; selectors are fixture-backed or documented defensive fallbacks.
- [ ] Autopilot/sensitive gating not bypassed.
- [ ] No new deps/config/manifest changes.
- [ ] Handoff complete and accurate.
- [ ] Commands actually pass; rerun if uncertain.
- [ ] UI accessible and responsive (if applicable).

**Severity:** `blocker` (must fix before merge) · `major` (fix in this wave) · `minor` (follow-up) · `nit` (optional).

---

## 9. Integration agent rules

- You are the only agent allowed to edit shared files, `TASKS.md`, and git.
- You may fix glue, import wiring, and trivial conflicts.
- You may **not** rewrite a feature module to make integration pass; send it back to the owner with issues.
- After each wave:
  1. run typecheck/lint/unit/integration;
  2. run E2E serially;
  3. update `TASKS.md`;
  4. write `.handoffs/WAVE-<n>.md`;
  5. commit.
- Keep a clean working tree between waves.
- If two agents conflict, the task that owns the file wins; the other gets a follow-up.
- Never merge a task with unresolved `blocker` issues.

---

## 10. Stop conditions

Stop and report immediately if:

- a contract is missing or wrong;
- a live DOM fixture is required but absent;
- a shared file must change;
- a dependency is required;
- tests fail for reasons outside your scope;
- you cannot meet acceptance without violating a rule;
- you are about to touch the live site;
- you find a security/privacy issue.

A clean blocked handoff is better than a broken merge.
