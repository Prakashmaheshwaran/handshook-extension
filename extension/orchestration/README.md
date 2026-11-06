# Orchestration — Running the Parallel Build

This folder is for the integration lead (the session that owns the repo). It explains how to turn [`TASKS.md`](../TASKS.md) into agent runs without creating merge chaos.

**Immediate next step:** [`WAVE-0.md`](./WAVE-0.md) contains the exact launch prompts for scaffold → contracts → shells → spike.

---

## 1. Prerequisites

- Owner has approved [`PLAN.md`](../PLAN.md).
- The repo is clean; integration commits before Wave 0.
- Node 20+ and npm are installed (T01 will confirm versions).
- Agents have read [`AGENTS.md`](../AGENTS.md) and the contracts.
- No agent has access to the live Handshake site.

---

## 2. Execution loop

For each wave:

1. **Pre-flight:** confirm the previous wave is committed and green.
2. **Spawn:** start only the tasks listed for the wave, at or below `max_agents`.
3. **Brief:** use the template in `AGENTS.md` §7, filled with the task's `Owns`, dependencies, and acceptance criteria.
4. **Collect:** each agent writes `.handoffs/<TASK_ID>.md`.
5. **Review:** spawn one review agent per 2–3 tasks (fresh context) with the review checklist.
6. **Integrate:** integration agent fixes glue only, runs the full suite, updates `TASKS.md`, writes `.handoffs/WAVE-<n>.md`, commits.
7. **Gate:** if the wave has a gate (G1/G2/G3/G4), do not start the next wave until the owner signs it.

---

## 3. Concurrency rules

| Wave |   Max agents | Notes                                    |
| ---- | -----------: | ---------------------------------------- |
| 0a   |            1 | Scaffold first; nothing else can start   |
| 0b   |            3 | Contracts, tests, UI shell               |
| 0c   |            2 | Background and content shells            |
| 0d   | 2 (one user) | Live capture + DOM utilities             |
| 1a   |            6 | Core modules with no live-DOM dependency |
| 1b   |            6 | Engine, providers, DOM adapters          |
| 1c   |            2 | Answers + dashboard/queue/activity       |
| 1d   |            2 | Apply flow + onboarding/settings/needs   |
| 2a   |            1 | Integration wiring                       |
| 2b   |            7 | E2E, polish, CI, store, security         |
| 3a   |            1 | RC hardening                             |
| 3b   |     1 + user | Live smoke, then submission              |

**Hard limits:**

- Do not run two agents that own the same file.
- Do not run E2E concurrently with another E2E or a dev server.
- Do not run `npm install` in a feature agent.
- Do not let agents run git commands.
- If an agent is blocked, do not start a replacement in the same slot until the handoff is read; you may lose more time to conflicts.

---

## 4. Model and tiers

All implementation agents use:

```
opencode-go/deepseek-v4.1-flash
```

Do not pass a different model unless the owner explicitly approves. Tier (`simple`/`normal`/`complex`) controls the brief's context and review depth, not the model.

- **complex:** include the full architecture sections + contracts; two review passes.
- **normal:** include the task, contracts, relevant architecture section; standard review.
- **simple:** include the task and acceptance only; light review.

---

## 5. Brief assembly

For task `T##`, build the prompt from:

1. `AGENTS.md` §7 template.
2. `TASKS.md` → `T##` section (objective, owns, steps, acceptance).
3. `ARCHITECTURE.md` sections named in the task.
4. `docs/CONTRACTS.md` types the task imports.
5. Fixture paths the task may use.
6. Dependency handoffs (`/handoffs/<dep>.md`) for API details.

Do **not** include the entire repo or other tasks' source. Agents should read files themselves.

---

## 6. Review and integration

### Review agent prompt (short)

```md
Review the work for <TASK_ID> against extension/TASKS.md and extension/AGENTS.md.
Read the handoff, inspect the diff, run the task's tests and typecheck.
Do not fix code. Return:

- blockers (must fix)
- majors (fix this wave)
- minors/nits (follow-up)
- scope violations (files outside Owns)
- acceptance checklist with pass/fail
```

### Integration agent responsibilities

- Only agent allowed to edit shared files, `TASKS.md`, and git.
- Fix glue/imports/trivial conflicts; do not rewrite feature logic.
- Run `npm run typecheck`, `npm run lint`, `npm test`; run E2E serially.
- Update status, write wave handoff, commit.
- Keep a clean tree between waves.

---

## 7. Failure and retry policy

| Situation                                     | Action                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Agent blocked on missing contract/shared file | Read handoff; integration applies the change; resume the same task             |
| Agent fails acceptance once                   | Re-run **same task** with the numbered review issues                           |
| Fails twice                                   | Split the task or assign to a complex-tier agent; do not let it block the wave |
| Tests fail outside scope                      | Integration triages; do not ask the agent to fix unrelated code                |
| Merge conflict                                | File owner wins; the other change goes to a follow-up task                     |
| Flaky E2E                                     | Quarantine with an issue; do not hide with retries                             |
| Live site issue                               | Stop; user-only investigation; no agent workaround                             |

---

## 8. Status and audit trail

- `TASKS.md` status column is updated by integration only.
- `.handoffs/<TASK_ID>.md` is the agent's audit trail.
- `.handoffs/WAVE-<n>.md` is the integration summary:
  - tasks completed/blocked
  - tests run and results
  - contract changes
  - risks introduced/resolved
  - next wave readiness
- Keep handoffs until the release is stable; they are useful for post-mortems.

---

## 9. Definition of a wave complete

- [ ] All wave tasks `done` or explicitly deferred with owner approval.
- [ ] Full typecheck/lint/unit/integration green.
- [ ] E2E green if the wave has E2E.
- [ ] Build loads in Chromium.
- [ ] No unresolved blocker findings.
- [ ] Contract changes documented.
- [ ] `TASKS.md` updated.
- [ ] Wave handoff written.
- [ ] Commit made (integration).
- [ ] Gate signed off (if applicable).

---

## 10. What not to do

- Do not spawn all 35 tasks at once.
- Do not let agents "help" outside their files.
- Do not skip contracts to save a day; it costs a week in integration.
- Do not run E2E against the live site.
- Do not merge around a failed acceptance because "it works locally."
- Do not let the plan drift silently; update the docs with an ADR.
