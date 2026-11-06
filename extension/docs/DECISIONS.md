# Architecture Decision Records

Short, durable decisions with context and consequences. If a decision changes, add a new ADR; do not rewrite history.

---

## ADR-001 — Use WXT for the extension framework

**Status:** accepted
**Date:** 2026-10-25

**Context:** We need MV3, a side panel, content scripts, background worker, Vite/React, and a plausible Firefox path later. CRXJS has had maintenance gaps; hand-written Vite requires a manifest/build ritual.

**Decision:** Use WXT with React + TypeScript.

**Consequences:**

- Typed entrypoints, automatic manifest generation, side panel entrypoint, HMR.
- One more framework to learn, but far less build plumbing.
- Firefox target is possible later without a rewrite.
- Generated types (`wxt prepare`) must run in CI.

---

## ADR-002 — Chrome/Edge first, MV3 only

**Status:** accepted
**Date:** 2026-10-25

**Context:** Chrome desktop is the dominant Handshake environment. Firefox/Safari/mobile add platform work without validating the core product.

**Decision:** Ship Chrome MV3; Edge Add-ons reuses the package. No Firefox/Safari/mobile in v1.

**Consequences:**

- The current manifest sets Chrome 116+ as the minimum. Edge/Brave need side-panel
  compatibility checks before being advertised as validated targets.
- No Safari notarization/Xcode work.
- Firefox users are unsupported until a later port.
- WXT keeps the option open.

---

## ADR-003 — Side panel only, no popup

**Status:** accepted
**Date:** 2026-10-25

**Context:** The app needs a persistent surface for queue, needs-you, activity, and settings. A popup closes when the user clicks the page; a side panel stays visible while the runner tab operates.

**Decision:** Use `chrome.sidePanel`; the toolbar action opens it via `setPanelBehavior({openPanelOnActionClick: true})`. No `default_popup`.

**Consequences:**

- Persistent UI and easy "Review in tab" workflow.
- Chrome-only API; Firefox needs `sidebar_action` later.
- Must handle narrow widths (320–480px).

---

## ADR-004 — No backend in v1

**Status:** accepted
**Date:** 2026-10-25

**Context:** A backend adds accounts, data breach surface, privacy policy complexity, hosting, and store review scrutiny. The core value does not require one.

**Decision:** All data and logic live in the browser. AI is optional: local heuristic matching or BYOK direct to the provider.

**Consequences:**

- Strong privacy story and simpler launch.
- No cross-device sync, no shared AI key, no server-side analytics.
- A future backend is possible behind a feature flag; it must remain optional.

---

## ADR-005 — UI-first application, API for details only

**Status:** accepted
**Date:** 2026-10-25

**Context:** The Python tool POSTs to `/jobs/{id}/applications` and falls back to Selenium. Direct POST is brittle for custom questions/documents and looks more bot-like. The real UI handles validation and unknown fields.

**Decision:** Drive the actual application form. Use same-origin GET endpoints for
job-detail enrichment and DOM extraction for application form fields. No direct application
POST fallback or CSRF-token extraction is implemented; any future addition needs a
separate review.

**Consequences:**

- Better correctness and question coverage.
- More DOM maintenance than an API-only tool.
- Slower per application (acceptable; human pacing is a feature).
- Must invest in selectors, fixtures, and health reporting.

---

## ADR-006 — Review-first, confidence-gated autopilot

**Status:** accepted; review-first default superseded by ADR-020
**Date:** 2026-10-25

**Context:** Auto-submitting unknown attestations or custom answers is unsafe and can
misrepresent the user. Platform enforcement can change; no numeric platform limit is
assumed here. Volume is not the product's value.

**Decision:** Default to review mode (superseded by ADR-020, which makes automation the
default). Autopilot only when all inputs are known: Quick Apply/known form, docs present, no unknown/sensitive-unapproved questions, cap not reached, session logged in. Otherwise Needs You.

**Consequences:**

- Lower risk of wrong/duplicate applications.
- Slightly less "hands-off" than the original ask, but honest and usable.
- The autopilot gate is a pure function with tests; end-to-end enforcement still needs
  verification at each message/content boundary in the final release.

**Superseded in part by ADR-020 (2026-10-28):** automation is now the default and Review
is the opt-out. The gating rules and Needs You behavior above remain.

---

## ADR-007 — Local-first AI (historical cloud-provider choice)

**Status:** accepted; on-device provider choice superseded by ADR-019
**Date:** 2026-10-25

**Context:** We want AI without shipping a shared key or requiring a backend. Chrome's
on-device Prompt API depends on the browser, hardware, and model availability. Cloud
AI sends data to a provider and remains optional.

**Decision:** Default to a deterministic heuristic. Offer on-device Nano when available,
and optional cloud matching with the user's key. The original 1.0.0 choice of Gemini
is superseded by ADR-018 below; local-first behavior and resume-only scope remain.

**Consequences:**

- Works offline and without setup.
- Nano availability is checked at runtime; browser/hardware requirements can change.
- BYOK shifts key management to the user; no shared key abuse.
- AI cannot submit, fill answers, or take actions.

---

## ADR-008 — Single content script with SPA route watcher

**Status:** accepted
**Date:** 2026-10-25

**Context:** Handshake is a single-page app; content scripts do not re-run on client-side navigation. Multiple content scripts increase manifest complexity and duplicate bundles.

**Decision:** One `handshake.content.ts` matching Handshake hosts, with a `location.href` watcher (500ms + `popstate`) dispatching debounced route changes to feature adapters.

**Consequences:**

- Works across SPA navigation without reloads.
- One injection guard needed.
- Slight idle polling cost; acceptable.
- Feature adapters register by page type; no shared entry edits.

---

## ADR-009 — Storage split: `storage.local` vs IndexedDB

**Status:** accepted
**Date:** 2026-10-25

**Context:** Settings/state are small and need synchronous-ish access; jobs/events/answers/cache are large and indexed.

**Decision:** `chrome.storage.local` for settings, engine state, onboarding, AI keys. IndexedDB for jobs, queue, events, answers, documents, AI cache, submissions, meta.

**Consequences:**

- Right tool per data size; no giant JSON blobs.
- Two storage APIs to reason about.
- Background is the single writer; content/UI send commands.
- Migrations must cover both (settings schema + DB version).

---

## ADR-010 — Zod contracts at every boundary

**Status:** accepted
**Date:** 2026-10-25

**Context:** Parallel agents and multiple runtime contexts (UI, worker, content) invite shape drift and unsafe casts.

**Decision:** Define all shared types as Zod schemas; infer TS types; validate messages, settings patches, storage reads, and AI output.

**Consequences:**

- Runtime safety and self-documenting contracts.
- Small bundle/runtime cost.
- Contracts must be frozen before Wave 1; changes go through integration.
- Errors map to `INVALID_INPUT` without leaking values.

---

## ADR-011 — Dedicated pinned runner tab

**Status:** accepted
**Date:** 2026-10-25

**Context:** MV3 service workers sleep; the application modal is stateful; using the user's active tab is disruptive; multiple tabs invite detection.

**Decision:** One pinned, non-discardable runner tab on the Handshake host. The content script executes the loop; the background coordinates. One job at a time.

**Consequences:**

- Stable context and observable progress.
- Chrome must stay open; laptop sleep pauses.
- Need tab lifecycle handling (close/discard/restart).
- No parallel applications.

---

## ADR-012 — No file uploads in v1

**Status:** accepted
**Date:** 2026-10-25

**Context:** Browsers do not allow scripts to set file input files without `chrome.debugger` (scary permission/infobar). Handshake applications primarily select existing documents.

**Decision:** Select existing Handshake documents only. If a required document is missing, pause and link the user to Handshake. No generated PDFs or uploads.

**Consequences:**

- Avoids a high-risk permission and complexity.
- Users must upload documents in Handshake first.
- Future: generated cover letters via a separate, explicit flow.

---

## ADR-013 — No telemetry in v1

**Status:** accepted
**Date:** 2026-10-25

**Context:** Job/resume data is sensitive; store review and user trust favor local-only. We can debug with exported diagnostics.

**Decision:** No analytics/telemetry/remote logging. Diagnostics are user-initiated exports.

**Consequences:**

- Strong privacy and simpler policy.
- Slower feedback loop; rely on beta reports and fixtures.
- A future opt-in, privacy-preserving error report can be considered.

---

## ADR-014 — Keep the Python tool as legacy/reference

**Status:** accepted
**Date:** 2026-10-25

**Context:** The Python tool works and encodes years of behavior. Deleting it before the extension is stable creates risk and loses a reference oracle.

**Decision:** Keep the Python repo unchanged; add `extension/` alongside it. Do not share storage or run both on the same account simultaneously.

**Consequences:**

- Easy behavior comparison and fallback.
- Two codebases temporarily; documentation must make the status clear.
- Archive the Python tool after 30 days of stable extension use.

---

## ADR-015 — External ATS is a handoff, not automation, in v1

**Status:** accepted
**Date:** 2026-10-25

**Context:** Workday/Greenhouse/Lever/Ashby/iCIMS each have their own auth, forms, CAPTCHA, and file uploads. Automating them is a separate product with high maintenance.

**Decision:** Detect external apply, do not click through blindly, and mark `external`.
The user follows the employer link and completes it manually; the runner remains on
Handshake. An external handoff is not evidence of a submitted application.

**Consequences:**

- Honest coverage; no false "applied" state.
- Some Handshake jobs require manual completion.
- Clean interface for a future ATS module.

---

## ADR-016 — Conservative product pacing defaults

**Status:** accepted; partially superseded 2026-11-05
**Date:** 2026-10-25

**Context:** The old tool used 50/day and 60–120s delays. The extension makes applying
easier, increasing over-application risk. Platform enforcement is not a stable product
contract and must not be inferred from Handshook's own limits.

**Decision:** 25/day default, 100 hard cap, 60–120s jitter, 10-app session breaks, 08:00–22:00 active hours, stop on repeated failures/429.

**Consequences:**

- Conservative product limits, not a statement of the platform maximum.
- Delays/caps cannot guarantee account safety or application quality.
- Users can raise the cap to 100 but not beyond in v1.

**Update 2026-11-05 (pacing-speed):** speed presets now target roughly 6–10, 12–18,
20–30, 32–40 and 100–130 applications per hour including apply time and breaks, with
the Faster preset (63–73s between applications) as the default. New installs keep the
15/day cap and 100 hard cap;
the time-of-day gate is retired. Every preset description and the Settings slider rate
come from one estimator (`estimateAppsPerHour`), and raw delay/jitter fields are no
longer editable or shown. Pacing remains a load-reduction default, not a platform
guarantee.

---

## ADR-017 — Draft releases and explicit public-hosting gate

**Status:** accepted for HX-09 distribution preparation
**Date:** 2026-10-27

**Context:** The source repository is private and no release is published. Authenticated
GitHub links do not provide public store policy/support pages or downloads for friends.

**Decision:** Tags `ext-v<version>` run automated fixture/mock gates and stage only the
validated store ZIP/checksum in a draft GitHub Release. The owner chooses public source,
separate public distribution, or private ZIP sharing and maintains all destination URLs
in [STORE.md](./STORE.md#distribution-links). Store submission/publication stays an owner action.

**Consequences:** No new secrets or Pages deployment; no accidental publication of
audit/hardening documents. Owner smoke, public URL checks, and final screenshots remain
open gates. Private ZIP sharing does not satisfy the store's public policy requirement.

---

## ADR-018 — Replace Gemini with optional OpenRouter model choice

**Status:** accepted for 1.1.0; supersedes ADR-007's cloud-provider choice
**Date:** 2026-10-27

**Context:** A fixed cloud vendor/model restricts user choice and ties availability
to that vendor's lifecycle. The owner wants any suitable OpenRouter model, one
user-owned key, and access to free options while retaining Nano and local matching.

**Decision:** Remove the direct Gemini integration and its host permission. Use
OpenRouter with a user-selected text-output model and at most two distinct optional
fallbacks. AI stays off by default. Auto tries opted-in available Nano, then
OpenRouter with key/model/permission, then heuristic. No cloud model is preselected.

Default `ai.openRouter` is `{ model: null, fallbackModels: [],
allowDataCollection: false, zeroDataRetention: false,
maxPromptPricePerMillion: null }`. Send `provider.data_collection: 'deny'` unless the
user opts in. Zero-data-retention is a separate optional constraint; never relax
privacy settings to rescue a failed request. Request/recheck the optional
`https://openrouter.ai/*` grant for chat, catalog, and key-info requests. Keep the
key unencrypted in isolated local storage, excluded from exports/logs/content scripts.

**Trade-offs and consequences:**

- One key and catalog offer model choice, including low-cost structured-output
  models and free variants, without a project backend or bundled shared key.
- OpenRouter adds a third-party routing layer: the disclosed job/resume metadata
  reaches both OpenRouter and the selected model's provider. Their policies apply;
  denying collection is not a blanket zero-retention guarantee.
- OpenRouter bills the user. Paid fallbacks have their own rates; a prompt-price
  ceiling does not cap output cost or total spend. Tests also consume usage.
- Free variants have daily limits, can expire/disappear, and may require providers
  that collect data. The default denial may leave no eligible route. Users can
  choose a compatible model or explicitly opt in after reviewing the policy.
- Support structured JSON when available, validate every resume choice, preserve
  abort/timeout/shared pacing and actual-model cache identity, and fall back to
  local matching on invalid output, credits, quotas, privacy, or availability errors.
- Delete stored Gemini keys on update; migrate old provider settings and backups
  without credentials, supply defaults, and show a one-time notice. Cloud matching
  requires a new OpenRouter key, model choice, and permission grant.

**Superseded in part by ADR-019 (2026-10-28):** the built-in browser AI provider is
removed, so Auto now tries OpenRouter (key, model, permission) and then heuristic.
The OpenRouter contract, defaults, and privacy rules above remain current. **ADR-020
(2026-10-28)** additionally preselects `deepseek/deepseek-v4.1-flash`, turns AI on by
default, and adds page assist; routing privacy controls stay as described here.

See [contracts](./CONTRACTS.md#10-ai-contracts),
[privacy](./PRIVACY.md#ai-matching-and-page-assist),
and [user setup and model guidance](./FAQ.md#what-is-openrouter).

---

## ADR-019 — Manual document IDs; remove the built-in browser AI provider

**Status:** accepted for 1.1.0; supersedes ADR-007's on-device provider and the
document-scraping design in ADR-005's consequences
**Date:** 2026-10-28

**Context:** Reading the Handshake documents page (table headers, category mapping,
client-side pagination, 404 handling, refresh state) was the largest source of live
document-selection failures, and it needed maintenance every time the page changed.
Chrome's built-in model was also unreliable across Chrome builds and devices: it could
be missing, need a large download, or become unavailable after browser changes. The
owner wants document setup the user controls directly and AI that is either explicit
(OpenRouter with the user's key) or deterministic (heuristic).

**Decision:**

- Documents are entered manually. The user opens their Handshake documents page from
  Handshook (a normal new tab), opens a document, and pastes its link
  (`https://app.joinhandshake.com/docs/12345678`) or bare ID. Settings store the
  parsed ID plus an optional user-typed name for the default resume, optional cover
  letter, transcript, and other document, and up to five named additional resumes.
- Handshook never reads, lists, paginates, refreshes, or caches the documents page.
  The former collection message, inventory store, freshness timestamp, and `/docs`
  fixtures are removed. `configuredDocuments()` is the only source of available
  documents; selection is ID-exact and required types without an ID wait in Needs You.
- Remove the built-in browser AI provider entirely: its opt-in flag, provider value,
  availability checks, enable message, and model download. `AiProvider` is
  `heuristic | openrouter`; Auto tries OpenRouter with a key/model/permission, then
  heuristic. AI candidates are the default plus additional resumes, gated by
  `documents.autoSelectResume` and no per-job resume override.
- Settings upgrade maps a stored built-in-provider selection to `auto` and drops the
  removed fields. Existing default/cover/transcript IDs keep working; additional
  resumes must be re-entered once because the old document list (and its allow-list)
  is gone.

**Consequences:**

- Fewer DOM dependencies and no silent document substitution: Handshook knows only
  what the user entered.
- Users must copy one link per document and re-enter additional resumes after
  upgrading. Setup has an explicit link to the Handshake documents page.
- Names are labels, not identifiers: an empty name means selection by ID only, and no
  title matching or picker typing.
- One-click Apply still uses Handshake-profile defaults; Review was the default at the
  time of this decision (see ADR-020).
- The privacy surface shrinks: no page inventory is read, and matching has at most
  two providers (user-keyed OpenRouter or local heuristic).

**Superseded in part by ADR-020 (2026-10-28):** full automation is now the default.
The manual-document-ID decision, the removed browser AI provider, and the matching
rules above remain current.

---

## ADR-020 — Full automation by default, with AI page assist

**Status:** accepted for 1.1.0; supersedes ADR-006's review-first default and ADR-019's
"Review remains the default" consequence
**Date:** 2026-10-28

**Context:** The product exists so the user can start a run and walk away. Live evidence
(owner screenshot, 2026-10-28) shows an ordinary job page: a single plain **Apply**
button with no `aria-haspopup`, opening a dialog with a preselected resume card, a
**Search your cover letters** input, and **Submit Application**. Handshook treated that
plain Apply as a possible one-click send and handed cover-letter jobs to the user
(`manual_submit_required` with `ONE_CLICK_APPLY_REVIEW_REASON`), so automation stopped at
this ordinary form shape. Separately, the legacy Python CLI applied through
`POST /jobs/{id}/applications` (CSRF token plus document IDs); that code no longer runs
and is unverified against today's site.

**Decision:**

- **Full automation is the default.** `mode: 'autopilot'`, `reviewBeforeSubmit: false`,
  `allowOneClickApply: true`, saved answers used without per-answer approval
  (`allowSensitiveAutoSubmit`, `allowEeoAutoFill`, `allowFreeTextAutoFill` true), AI
  matching on, and AI page assist on.
- **Handshook fills Handshake's own dialog.** It clicks a plain Apply, verifies or selects
  the resume card, uses the "Search your cover letters" picker, fills saved answers,
  clicks **Submit Application**, and requires positive confirmation. It never treats a
  dialog-opening Apply as an instant one-click send.
- **Review is an opt-out.** Review mode, an explicit Dry run, and every individual switch
  can be chosen instead. A one-time defaults revision (2) moves existing installs; a saved
  Dry run stays Dry run, and later choices are preserved.
- **Only two things stop a job for the user:** a required question with no saved answer,
  or a required document with no entered ID. Every existing gate stays: exact document
  IDs, submit authorization bound to the exact attempt, no unknown required question, no
  visible validation error, positive confirmation afterwards.
- **AI page assist may choose which control to use** when selectors miss, from a numbered
  list of control labels, roles, and allow-listed attribute names. It never sends
  answers, form values, document contents, or URLs; deterministic rules veto destructive
  controls and wrong-location picks; all verification still runs; picks are remembered
  locally (three per target and host) and tried before any network call.
- **Direct HTTP applying is not used.** `POST /jobs/{id}/applications` is unverified
  against today's site, bypasses the dialog's required questions and document selection,
  and would submit without the DOM checks that make the outcome verifiable.

**Trade-offs and consequences:**

- Fewer "click Apply yourself" handoffs, and more applications sent without per-job
  review. Caps, pacing, active hours, and Stop remain; each switch can restore a
  conservative flow.
- The dialog is a larger DOM surface than a one-click button. Resume card, cover-letter
  picker, and Submit Application can change; page assist narrows that gap but adds a
  third-party request and its own failure mode (no key, no permission, model error → the
  normal `UI_CHANGED` / Needs You path).
- Page assist sends page structure — labels, roles, and a few attribute names — to
  OpenRouter and the model provider. It sends no answers, values, document contents, or
  URLs. The Privacy Policy and store worksheet disclose this exactly; it needs the user's
  key and can be turned off in Settings.
- Existing installs change behavior once on update. The change is documented in the
  changelog, README, FAQ, and install guide, and an explicit Dry run is preserved.
- Automation is still not a guarantee of account safety or application accuracy; the
  existing limits and Stop control remain the user's tools.

See [apply flow](./ARCHITECTURE.md#10-apply-flow), [AI and page assist](./ARCHITECTURE.md#13-ai),
[contracts](./CONTRACTS.md#10-ai-contracts),
[privacy](./PRIVACY.md#ai-matching-and-page-assist), and
[selector fallback](./SELECTORS.md#page-assist-fallback).

## ADR-021 — AI answer assist grounded in the answer bank

**Status:** accepted for 1.1.0
**Date:** 2026-10-30

**Context:** Owner review of a real install (2026-10-30) found that full automation still
stopped on ordinary questions. Any wording difference between a form question and a
saved answer — "What is your cumulative GPA?" against **Cumulative GPA** — was demoted
to Needs You even for an approved answer, and setup saved non-sensitive answers as not
automatic without offering a switch. The owner asked for AI to answer from the answer
bank rather than not at all.

**Decision:**

- **Answers come only from the answer bank.** When the label matcher finds no exact
  match, the content script describes the unmatched questions (label, type, section,
  choice labels) to the background, which asks the OpenRouter model which saved answer
  each one asks for. The model receives saved-answer ids, labels, aliases, types and
  categories, never values, and may answer "none".
- **Deterministic checks decide.** The background loads the bank itself and rejects
  unknown ids, a confidence below 0.8 (0.9 for sensitive or EEO questions), and an answer
  whose value does not fit the question's choices. The content script re-runs the
  per-answer and global approval checks and option resolution before filling.
- **Matches are learned.** A confirmed mapping (question type + normalized wording →
  answer id, up to 200) is stored locally and reused before any network call.
- **Entered answers are automatic.** New answers default to automatic, and a one-time
  answers revision makes existing value-bearing answers automatic; new databases start
  at the current revision so later opt-outs are never overridden.
- **AI does not compose free text.** Writing new prose or values from the bank (a cover
  note, a combined date) would invent facts; such questions still wait in Needs You.

**Trade-offs and consequences:**

- Fewer Needs You stops for reworded questions, at the cost of one small model call per
  new wording, billed to the user's key and skipped once learned.
- A wrong mapping fills a real saved value into the wrong question. The confidence
  floors, the choice-fit check and the "same meaning, not merely related" instruction
  reduce this; the user can turn answer assist off or opt individual answers out.
- Without a key, behaviour is unchanged: reworded questions wait in Needs You.

## ADR-022 — AI-written answers after the answer bank; a question inbox

**Status:** accepted for 1.1.0; extends ADR-021
**Date:** 2026-10-30

**Context:** The owner asked for AI to answer questions on its own, using the answer bank
when it cannot, and for the extension to collect the questions applications actually ask
so users can answer them up front. The owner chose (2026-10-30): saved answers first; AI
never guesses personal facts; only non-sensitive saved answers may be sent; collect
questions from runs, common templates, and Dry runs. A real install also showed one
unanswered question halting the whole Autopilot run.

**Decision:**

- **Order:** exact saved answer → AI mapping to a saved answer (ADR-021) → AI-written
  answer → Needs You. The bank always wins; AI never overwrites a question the bank knows.
- **AI writes only non-personal answers.** A deterministic veto (`aiMayWrite`) removes
  sensitive, EEO and personal-fact questions (experience, skills, education, dates,
  availability, history, contact details, location…) and non-text/choice types before any
  request; free text also needs the free-text switch. The model receives the job posting
  and non-sensitive saved answers (with values) and must answer "none" unless the posting,
  those facts or common knowledge fully support an answer. Replies must clear a 0.75
  confidence floor, match a form option exactly for choices, and fit a length limit.
  Every written answer is logged to Activity and kept per job.
- **Question inbox.** Unanswered questions from Needs You and Dry runs are stored locally
  (wording, type, choices, last job IDs; 200 max) and shown with common templates in
  Settings → Answers. Saving an answer requeues every waiting job whose questions are now
  all covered.
- **Dry runs read only declared forms.** A Dry run clicks Apply only when it declares a
  dialog (`aria-haspopup="dialog"` or `aria-controls` → dialog), reads the questions, and
  never fills, selects or submits. Live Handshake often renders a plain Apply that may
  submit on click; those are skipped, so live coverage is partial until a safe signal is
  confirmed.
- **Autopilot continues past Needs You.** A `needs_input` job is parked and the run
  schedules the next job; Needs You answers save during a run and requeue the job. Review
  mode still pauses.

**Trade-offs and consequences:**

- Non-sensitive saved answers and job text now reach OpenRouter and the model provider when
  writing is on; sensitive answers never do.
- AI-written motivation answers are generic but grounded; a user wanting their own wording
  can turn writing off or answer in Needs You.
- The personal-fact veto is broad and will sometimes send an answerable question to Needs
  You; that is the intended failure direction.
