# Changelog

All notable changes to Handshook are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased - 1.1.4

Integrated release candidate; no public release or live-account acceptance is claimed.
Version metadata is 1.1.4. Patch versions 1.1.1–1.1.4 were internal bumps while the
changes below landed; no separate public release was made for them. The merged
OpenRouter switch passes **1,066 Vitest tests**,
**97 headless E2E cases**, and build/ZIP/package gates; current source/checksum and
review findings are in [integration evidence](../docs/hardening/INTEGRATION.md#openrouter-switch).
Earlier hardening counts below remain historical pre-switch evidence. The full-automation
default and AI page assist are newer than that evidence; per-worker gate results are
recorded in `extension/.handoffs/`. Owner validation/release gates remain open before
tagging `ext-v1.1.4`.

### Changed

- **The default apply pace is 10 seconds slower.** The default Faster preset now waits
  63–73 seconds between applications (was 53–63), moving the derived rate to about
  32–40 applications per hour including apply time and breaks. The other presets are
  unchanged; custom Advanced timings are untouched.
- **Faster, quieter speed presets with a truthful rate indicator.** The five presets now
  target roughly 6–10, 12–18, 20–30, 32–40 and 100–130 applications per hour including
  apply time and breaks, and the Faster preset is the default. Settings shows one Speed
  slider plus a rate derived from the effective pacing (including saved custom values);
  the raw shortest/longest delay and jitter controls are no longer displayed. Waits shorter
  than 30 seconds now use a precise in-memory timer instead of degrading to an alarm tick.
  New installs keep the 15/day cap and 100 hard cap.

### Fixed

- **Reaching the daily cap now ends the run.** A run that used today's cap used to sit in
  Paused with Resume and Stop buttons, which looked like it was still running. It now
  finishes like Stop: the engine goes idle, clears its scheduled wake-up, and the dashboard
  says the run finished and to start again after local midnight. The cap is checked before
  an Autopilot rescan, Start after the cap stays idle with an explanation, and a run an
  older version left Paused at the cap is shown as finished after the update.
- **Setup's session check now reports what actually happened.** The card distinguishes
  "Not checked yet" from a real post-check **"Couldn't verify"** with a _Check again_
  button, and shows where and when the check ran. The check reads the already-loaded
  Handshook runner tab first, only reloads when that answer is inconclusive, runs with the
  tab foregrounded so client-side rendering is not throttled, and waits up to 12 seconds
  for account evidence. A missing content script, a tab that cannot load, or a rejected
  request now reports "couldn't verify" instead of "not signed in".

### Added

- **Report a problem button.** Settings → Advanced and the diagnostics page open a GitHub
  bug report prefilled with the Handshook version, browser, OS, run mode, and up to five
  reviewed error codes; no message text, URLs, or job details are included, and nothing is
  sent until you submit it on GitHub. A workflow lists every bug report, with its Open or
  Closed status, under **Reported by users** in [Known issues](./docs/KNOWN_ISSUES.md).
- **AI answers what your saved answers don't cover — never personal facts.** After the
  answer bank, questions that do not depend on a personal fact ("How did you hear about
  this position?", "Why are you interested in this role?") are answered by your OpenRouter
  model from the job posting and your non-sensitive saved answers. Work authorization,
  sponsorship, salary and EEO answers are never sent, and questions about experience,
  eligibility, dates, history or demographics are vetoed before any request. Each AI
  answer is listed in Activity. On by default; turn it off in **Settings → AI**.
- **Questions to answer.** Settings → Answers now lists every question a run met without a
  saved answer, plus common screening questions (major, degree, school, start date,
  relocation, on-site work, 18+, how you heard, LinkedIn, portfolio). Saving one puts every
  job waiting on it back in the queue. These common questions are also in setup.
- **Dry runs collect questions.** A Dry run reads the questions of application forms whose
  Apply control declares a dialog, without filling or submitting. A plain Apply is never
  clicked in a Dry run.
- **Autopilot keeps going past Needs You.** A job waiting on a question or document is
  parked while the run moves on; answering it in Needs You (now possible during a run)
  requeues it. Review mode still pauses the run.
- **AI answer assist, grounded in your answer bank.** When an application question is
  worded differently from your saved answers, Handshook asks your OpenRouter model which
  saved answer it is asking for. The model sees the question text and your saved
  answers' labels, never their values; Handshook fills your saved value, checks it fits
  the question's choices, and remembers the match so the same question needs no later AI
  call. Sensitive questions need a higher confidence, and every approval switch still
  applies. On by default; turn it off in **Settings → AI**. Previously any wording
  difference sent the job to Needs You.
- A saved number now picks the matching range choice locally — a GPA of 3.8 selects a
  "3.5 – 4.0" option — with no AI involved.
- **Answers you enter are used automatically.** Setup and Settings now save answers as
  automatic (setup offered no switch for non-sensitive answers such as GPA, graduation
  date or location, so they were silently not automatic). A one-time upgrade makes
  existing saved answers that have a value automatic; blank answers are unchanged, and
  each answer can still be opted out in **Settings → Answers**.
- **Document names are prompted.** Every document now has a name field explaining that
  Handshook types the name into Handshake's document search and AI uses it to choose
  between resumes, with a warning for documents that have an ID but no name. AI resume
  selection runs only when there are two or more resumes and all are named; otherwise
  the default resume is used with no model call.
- **Full automation is the default.** **Start** now applies without a review step:
  Handshook clicks a plain **Apply** button, fills Handshake's application dialog
  (the preselected resume card, the **Search your cover letters** picker, transcript
  and other document fields), clicks **Submit Application**, and requires positive
  confirmation before marking the job applied. One-click Apply is allowed, saved
  answers are used without per-answer approval, and AI matching is on. A required
  question with no saved answer or a required document with no entered ID still stops
  that job in **Needs you** with the exact question or document type. External employer
  sites are still a handoff.
- **One-time defaults upgrade for existing installs.** A new settings revision
  (`defaultsRevision: 2`) moves a saved Review install to Autopilot, turns the review
  step and per-answer approvals off, turns one-click Apply and AI on, and preselects
  `deepseek/deepseek-v4.1-flash` when no model was chosen. An explicit **Dry run**
  stays Dry run. Review, Dry run, and every individual switch remain opt-outs, and
  later saves are preserved.
- **AI page assist.** When Apply, Submit Application, the resume card, or a cover
  letter/transcript/other document field cannot be found by the normal selectors and
  page assist is on, Handshook asks OpenRouter (the user's own key) to pick one control
  from a numbered list of the page's control labels, roles, and a few allow-listed
  attribute names. It never sends answers, form values, document contents, or URLs.
  Deterministic rules veto destructive or unrelated controls (withdraw, delete, remove,
  cancel, upload, close/back, sign out, save, share, preview, or anything outside the
  target's expected location), and every existing
  document, question, authorization and confirmation check still runs. A model pick is
  remembered locally (three most recent per target and host) and tried before any network
  call, so the same page shape needs no later AI request. Turn
  it off in **Settings → AI**; it cannot run without a key and permission.
- An informed, default-on **Let Autopilot use Handshake one-click Apply** switch
  in Safety and Autopilot setup. These sends use Handshake-profile default files;
  their submission records say so without claiming a verified document ID.
- Friend-facing install guide and FAQ, with no-terminal ZIP installation and
  explicit store/public-hosting prerequisites.
- An extracted-release-ZIP walkthrough covers first-run setup, an automated submission,
  a Review opt-out run, Activity, default automation safety, recovery and diagnostics.
- Tag-triggered draft GitHub release workflow with a validated ZIP and SHA-256,
  plus an extension bug-report template that asks users to remove personal data.

### Changed

- **Review is now an opt-out.** `reviewBeforeSubmit` defaults to false, so Autopilot
  submits without a manual step; turning it on reproduces the previous conservative
  behaviour. Setup's mode step now defaults to Autopilot, and Home starts an automated
  run. Documentation no longer describes Review as the default.
- **`deepseek/deepseek-v4.1-flash` is the preselected OpenRouter model** for matching
  and page assist. A model chosen by the user is kept; a model can still be removed or
  changed in **Settings → AI**, and no key is bundled.
- **Documents are entered manually.** Setup and Settings now take a Handshake document
  link (`https://app.joinhandshake.com/docs/12345678`) or bare ID for the default
  resume, optional cover letter, transcript, and other document, plus up to five named
  additional resumes that AI matching or per-job choices can use. The link to your
  Handshake documents page opens it in a normal new tab; Handshook no longer reads,
  lists, paginates, or refreshes it, and the Refresh button and cached document list
  are gone. Selection is by exact ID; a name you type is a label and is only entered
  into a picker's search box when present. Previously chosen default, cover-letter,
  and transcript IDs keep
  working. Additional resumes were stored in the removed document list, so re-enter
  them once after updating; a required document without an ID waits in Needs You.
- **Chrome on-device AI (Gemini Nano) removed.** The provider, opt-in toggle, model
  download/availability checks, and enable message are gone. AI matching is now
  OpenRouter (opt-in, your own key) or basic keyword matching; Auto tries OpenRouter
  when a key, model, and permission are present, then falls back to keyword matching.
  Stored on-device opt-ins and a `nano` provider setting migrate to defaults on update.
- Gemini replaced by OpenRouter — choose any available text-output model with your
  own OpenRouter key. Local keyword matching remains available with no key; the
  built-in browser AI provider was removed in this release (see below).
  Matching and page assist are on by default but use only your key; without one,
  matching stays local and page assist does not run.
- Stored Gemini keys are deleted on update. Add an OpenRouter key, grant its new
  optional permission, and keep or change the preselected model to resume cloud
  matching. Existing settings
  and old backups migrate with safe routing defaults; credentials are not imported.
  A one-time notice explains the change.
- OpenRouter model choices include structured-output and free variants, up to two
  optional fallback models, and privacy/price controls. Provider data collection is
  denied by default; free models may require explicit opt-in and have daily limits.
  OpenRouter bills usage to you, including provider tests and paid fallbacks.
- Chrome 120 is now the minimum supported version, matching the engine's 30-second
  alarm requirement. AI matching needs no browser AI model; only local keyword
  matching or optional OpenRouter.
- Onboarding answers can wait until a job asks for them. Entered answers are saved;
  missing or unapproved required answers still prevent automatic submission.
- Setup, Settings, install and privacy copy now describe the actual controls, automatic
  resume matching, Handshake form sharing and optional AI payloads and authentication.
- Each saved answer can still be marked as not-automatic. Non-sensitive answers are
  created auto-submittable and sensitive answers follow the sensitive-answer switch
  (on by default), so a saved answer is used unless you opt it out. An answer that is
  not auto-submittable remains blank; explicit job answers can be filled for a Review
  opt-out run. Turning off the unknown-question pause never turns into guessing an
  incomplete form in Autopilot.
- Handshake forms verify exact chosen documents. One-click Apply / Quick apply use the
  profile-defaults switch (on by default), require Autopilot and fresh submit
  authorization; extra documents or known questions still wait for the user.
  Review, or Autopilot without a required answer, offers an explicit Open job handoff.
- Submission confirmation is always required to mark an application applied. The
  confirmation setting controls how long to wait; uncertain attempts remain available
  for review and reserve the daily cap without being retried automatically.
- Diagnostics now exports reviewed status codes, settings flags, counters and selector
  metrics, excluding personal text, search URLs, identifiers and credentials. Backups
  and application CSV remain private personal exports and scrub copied credentials.
- AI operations have cancellation and time limits, provider/model-aware caching, shared
  OpenRouter pacing and bounded model fallback. Provider failures fall back to local keyword
  matching; cancelling a job does not continue to an application.
- Distribution, privacy, store-readiness, and task-status documentation reconciled
  with baseline source and verified repository visibility.
- Queue, Needs You, Activity and toast notifications receive immediate engine updates
  while polling remains a fallback. Repeated manual Review confirmations update the
  journal and daily count once, including after worker restarts.
- Settings preserve typed keyword/location lists and checkbox, numeric, date and multiline
  answers. Confirmation dialogs retain focus, trap Tab/Escape correctly and keep failed
  actions available for retry.
- Needs You shows exact document errors and reason-specific recovery actions. Missing
  runner tabs, unconfirmed applications, absent default resumes and stale diagnostics
  now have actionable feedback. Export labels distinguish private data from diagnostics.

### Fixed

- **Quick apply finds and changes the attached resume.** The live dialog puts
  the "Attach your resume" heading and the attached file in separate containers
  inside one fieldset; the extension searched only the heading's own container
  and reported "resume field not found". The attached file is shown in a
  dismissible status alert: dismissing it (its "Close" control) reveals
  "Search your resumes", and the extension now picks your named resume there.
  When that name is not one of the files in the account, the form's own resume
  is put back so the application still goes through, and Activity reports the
  document actually sent. Picker labels are matched in the plural
  ("Search your resumes"), which previously failed too. The resume list is
  virtualised (~200 files, a few rows rendered), so the extension now waits for
  the filtered row instead of reading the list before the filter applies.
- **Check session** no longer reports "Not checked yet" for a signed-in user when the
  check lands while Handshake's home page is still redirecting or rendering. The page is
  given up to 5 seconds to show your account before the result is reported.
- Recognize the live Rosetta **Applied on** banner, **Withdraw application** and
  disabled Apply state on load and after a send. A fresh banner/toast is required
  for success; stale confirmations and disabled controls alone never prove a send.
- Direct job inspection now waits for bounded action readiness and accepts cancellation
  through the detail fetch. Diagnostics redaction version 3 documents the allowlisted
  action outline and boolean safety opt-ins; private page/document data stays removed.
- Saving an OpenRouter key no longer loads models while matching is off or a local
  provider is selected. **Load models** remains available for explicit setup.
- Missing, variable and extreme model prices display safely; oversized provider
  responses and model catalogs fail safely to local matching or a clear error.
- Unconfirmed submissions no longer look like filled forms ready to submit again.
  Needs You and refused Resume actions explain My Jobs verification, pending Review,
  and explicit Skip without clearing the replay barrier. Pause/cap/active-hours hints
  and sensitive-answer copy now describe the actual controls.
- Restart reconciliation now settles the daily count and applied Activity event
  together. Repeated reconciliation, late manual confirmations and Activity clearing
  cannot log or count the application twice.
- Store images now capture the current production extension with fictional data;
  updated captions disclose optional cloud AI and the automated default. Icon rendering,
  the full safety section, and the marquee no longer crop or repeat image content.
- Needs You retries the application page after answers and login recovery. The
  missing-document path asks for a link or ID and revalidates the configured IDs
  without reading the documents page. Concurrent recovery actions preserve the shared
  runner and unfinished Review forms.
- UI_CHANGED offers an explicit Queue Retry only for a settled, unsubmitted failure.
  Uncertain, submitted or confirmed attempts retain their replay barrier.
- Confirmed manual Review applications atomically update Queue, the journal, daily count
  and exactly one applied Activity event. Failed observation delivery retries until
  acknowledged; late or duplicate results cannot erase confirmation or count twice.
- Ambiguous Apply controls require manual handling. Submission and reconciliation stay
  bound to the exact job and school; document choices and approved answers are checked
  again at the final click. Negated success text and unchosen optional attachments
  cannot silently authorize or confirm an application.
- Resume preserves explicit dry-run and Review modes. Document, answer-approval and
  settings changes revoke an in-flight submit grant; pending Start/Resume cannot undo
  a later Pause/Stop, and detached worker failures stop automation.
- Detail API login and rate-limit responses stop the run before another endpoint or
  DOM-only application can bypass them.
- Stored OpenRouter keys are restricted to trusted extension contexts. Each provider request
  rechecks optional host permission, authenticates through a header, refuses redirects
  and removes reflected keys from explanations. Handshake JSON reads also refuse redirects.
- Pause, Stop and stricter Review settings revoke stale submit permissions, including
  while filling or preparing an application. Every automatic submitting click needs
  fresh authorization for the exact active attempt and runner tab.
- Exact document IDs/types, duplicate document names and committed picker selections
  are verified. Optional-picker failures stop for human input and retain verified
  documents and an actionable warning in the submission record.
- Answer matching and filling share one question-to-answer mapping, including resolved
  option values. Ambiguous controls, matches and choices fail safely.
- Full job details now determine filters and fit scores before applying. Waiting jobs,
  delayed retries, short pacing delays and active-hours wakes survive worker suspension;
  runner ownership and session breaks are restored without creating duplicate tabs.
- Daily-cap accounting records each submission attempt once, including uncertain
  responses and later reconciliation; uncertain attempts retain their replay barrier.
- Deterministic local-date tests, mandatory mock E2E/format CI gates and package-version
  and ZIP/checksum regressions strengthen release verification.
- Provider tests in Auto follow the same OpenRouter-then-heuristic order as matching;
  optional OpenRouter fallback status is visible. Setup validates entered document IDs
  and warns before finishing without a resume; key removal and saved-search deletion
  ask for confirmation.

### Technical notes

- Production builds select Zod's existing interpreted parser through a guarded build
  transform. Generated-bundle checks reject dynamic evaluation without relaxing MV3 CSP
  or modifying dependencies.
- OpenRouter's text-model catalog is cached for 24 hours with manual refresh. Matching
  and tests share the selected model/routing settings; the current host grant is
  rechecked before chat, model-list, and key-info requests. Cache keys include provider,
  responding model, prompt version, job text and resume metadata; timeouts and quota
  failures are bounded. Strict JSON schema is requested when supported.
- Diagnostics uses a versioned field allowlist and reviewed selector keys. New fields
  and unknown codes stay excluded until reviewed; local Activity identifiers still work.
- Message payloads and protocol versions are validated at transport boundaries. Apply
  events and submit grants require the exact runner, job, run and persisted attempt;
  stale scripts receive reload guidance without reloading an unfinished form.
- Packaging validates the existing build version against the extension package and
  generates a ZIP plus SHA-256. Draft-only release automation refuses published-asset
  mutation; publication remains an owner action.

### Validation and remaining owner actions

- Historical pre-OpenRouter verification: **951/951 Vitest tests**, **91/91 headless mock Playwright
  cases**, typecheck, lint, formatting, build, ZIP and validated packaging all pass.
  Exact tested commit, package SHA-256, conflict resolutions and risks are in the
  [integration report](../docs/hardening/INTEGRATION.md).
- OpenRouter integration passes **1,066/1,066 Vitest tests across 72 files** and
  **97/97 headless E2E cases**, with current source/review/ZIP-checksum evidence in
  [the OpenRouter integration report](../docs/hardening/INTEGRATION.md#openrouter-switch).
  OR-3 documentation checks remain recorded in [its report](../docs/hardening/OR-3.md).
- The extracted-ZIP walkthrough and document recovery are covered with headless mocked
  pages. Native toolbar/folder-picker installation and real-tenant behavior still need
  owner acceptance.
- Owner live Review smoke, public hosting, beta installs, and store submission remain
  open in [STORE.md](./docs/STORE.md#release-checklist).

## 1.0.0 — 2026-10-25

Historical release notes; not a claim of current store publication or full live-site
validation. See the current [release checklist](./docs/STORE.md#release-checklist).

First customer release. Handshook is a Chrome MV3 side-panel extension that reviews and
submits Handshake job applications in the user's existing browser session. It never
stores a Handshake password or reads cookies, and it keeps all data local.

### Added

- Chrome MV3 side panel for Handshake job applications, with review-first defaults at
  the time and an opt-in autopilot that only submits when every safety gate passes.
- Selectors verified against sanitized live Handshake DOM (Chrome 155): search result
  cards (`data-hook="job-result-card | {id}"`), `/job-search/{id}` card links, `/e/{id}`
  employer links, "At a glance" detail fields, `Apply` / `Apply externally` aria-labels,
  and pagination. Sanitized fixtures live in `tests/fixtures/live/`.
- Session detection and host auto-detection using the existing browser session. US and UK
  Handshake hosts are supported and configurable.
- First-run onboarding: welcome, session check, documents, reusable answers, saved search,
  run mode, and an explicit review-before-submit choice for autopilot.
- Job discovery from `/job-search` and `/postings`, with pagination, promoted-card
  handling, and a live empty-state signal.
- Job detail extraction and read-only `/stu/jobs/{id}` enrichment.
- Automatic resume selection: deterministic keyword matching, Chrome on-device Gemini
  Nano (downloaded from the panel with progress), or BYOK Gemini with a real provider test.
- Document selection for resume, cover letter, transcript, and other existing documents. A
  configured cover letter or transcript is attached when the form offers the field, even
  if it is not required.
- Screening-question detection and a reusable answer bank. EEO and sensitive answers
  require the matching opt-in; free text requires the free-text opt-in except for
  structured identity fields and date/number controls.
- Review mode that fills an application and stops before submit. A one-click Quick Apply
  with no review step is reported as **Manual submit required** instead of being clicked.
- Opt-in autopilot for Quick Apply and Handshake forms. At the time,
  review-before-submit stayed on by default and could only be turned off explicitly.
- Dry run that inspects and classifies jobs (`would_apply`) without clicking, filling, or
  submitting.
- Write-ahead submission records, restart reconciliation, and exactly-once browser-session
  recovery. A lost apply response is marked `verifying` and never retried automatically.
- Local job tracker, queue, daily caps, session breaks, jitter, active hours, and
  rate-limit backoff.
- Needs You screen for unknown questions, missing documents, review, auth, page changes,
  and uncertain submissions.
- Selector-health reporting after scans and applies, persisted for diagnostics and the
  export bundle.
- Activity log, diagnostics export, full backup/CSV export, legacy Python tracker/config
  import (T33), local reset, and a publishable privacy policy.
- Side-panel code splitting: Dashboard stays in the initial chunk; Queue, Needs you,
  Activity, Settings, and Diagnostics load on first visit via `React.lazy`.
- Final brand icon set (16/32/48/128 px), a simplified toolbar action icon, and a Chrome
  Web Store asset pack (four 1280×800 screenshots, 440×280 promo tile, 1400×560 marquee)
  generated from sanitized demo data by `scripts/generate-store-assets.ts`.
- Store listing pack in `docs/STORE.md` (listing copy, single-purpose statement,
  permission justifications, data-use disclosures, release checklist), end-user README,
  release guide in `docs/RELEASE.md`, and a security review in `docs/SECURITY-REVIEW.md`.
- Headless Playwright E2E suite against a routed mock Handshake site, with DNS pinning so
  an un-intercepted request cannot reach the live site.
- Store-ready packaging: `npm run package` validates an existing MV3 build, writes a
  versioned zip with a SHA-256 checksum, and rejects source maps, dotenv files, secrets,
  fixtures, docs, and unexpected permissions.

### Changed

- Version metadata is aligned at 1.0.0 across `package.json`, the WXT manifest, the side
  panel footer, and this changelog.
- The `tabs` permission was removed. The runner only creates and controls its own tab,
  covered by the Handshake host permissions; the built manifest requests `storage`,
  `alarms`, and `sidePanel` only.
- Extension CI now runs type checking, linting, formatting, unit/integration tests, the
  production build, Playwright E2E, and uploads the unpacked build and store ZIP.

### Fixed

- Stop, pause, and reset abort an in-flight apply with `content.cancel` and check the
  abort signal before the Apply/Submit clicks. A lost apply channel becomes `verifying`,
  never a duplicate submission. Apply requests are de-duplicated by request id.
- Scan continuations use a run-generation token, so pausing during a scan cannot enqueue
  jobs or overwrite engine status.
- Final queue rows (`applied`, `external`, `already_applied`, `filtered`, `blocked`)
  cannot be retried, skipped, re-applied, answered, or requeued by any UI or background
  path.
- Applied/closed/not-open detection, confirmation detection, and the review watcher are
  scoped to status/action regions and job identity; job-description prose cannot mark a
  job final, and a pre-action baseline prevents stale banners.
- Answer metadata, category, and sensitivity are derived from the stored question at
  match time and on import; a stored `false` cannot bypass the sensitive-answer opt-in.
- Answers keep the rest of the question set; a job is requeued only when no question or
  document remains. Job-specific answers take precedence over the shared bank.
- Missing documents can be re-checked from Needs You; a login redirect or unreadable page
  never wipes the local document bank. Document refresh merges by id and preserves notes.
- Re-scans preserve queue status, attempts, backoff, questions, and errors.
- Reset stops the engine, cancels an in-flight apply, clears the alarm and Gemini key,
  deletes IndexedDB, restores settings/onboarding, and reports failure if another tab
  blocks deletion.
- Runner focus reports honestly; the runner only ever reuses or opens its own tab.
- Gemini permission/test, on-device model download, selector health, full backup export,
  host selection, and stale-refresh notices are wired and truthful.
- Imported searches, jobs, and backup settings are restricted to HTTPS Handshake URLs; the
  runner refuses any other destination.
- Backup import previews the exact file contents, resets autopilot mode and unsafe
  auto-fill flags to safe defaults with an itemized warning, and rejects unsupported
  future versions.
- Previous-shape settings/onboarding records are upgraded over defaults instead of being
  discarded; a corrupt settings object still falls back to defaults.
- Reconcile never resurrects skipped, blocked, or otherwise terminal rows into
  `needs_input`; skipping closes the related submission.
- Active hours are enforced on every engine tick, not only at Start.
- Resume re-reads the current mode and settings, so switching to Review while paused takes
  effect on the next run.
- Quick-apply outcomes report uncertainty (`verifying`) instead of fabricating an applied
  result. Non-retryable apply failures always schedule the next tick or pause with the
  proper reason instead of leaving the engine stalled in `running`.
- Autopilot keeps the queue's fit score, reasons, and source when a live
  `inspectJob` refresh returns DOM-only fields. Default autopilot now clears its
  fit gate for well-fitting jobs instead of silently forcing review.
- Switching Settings to Review mid-run takes effect immediately; Review always
  wins over a stale autopilot run mode at apply time.
- Skipping the in-flight job cancels the content-side apply, keeps the row
  skipped even if a late result arrives, and reschedules the run.
- A Needs You answer the user explicitly supplied is approved to fill even when
  the global sensitive/EEO/free-text opt-ins are off. Autopilot without those
  opt-ins stops at Review instead of looping back to `needs_input`.
- Review mode no longer clicks a Quick Apply control whose `aria-haspopup` is
  only `true` (a menu); a proven dialog is required.
- The review-confirmation watcher matches exact job path segments, so job 1234
  cannot be credited by a confirmation on job 12345.
- Backup import documentation now matches the code: unsafe mode/safety flags are
  reset to safe defaults with an itemized warning, not silently enabled.
- A late apply result after Skip now uses the normal outcome mapping: late
  `verifying`/review outcomes are recorded as ambiguous (not failed), and a late
  `applied` marks the row applied and immutable. Retry, Apply-now, and the engine
  pre-apply guard refuse any job whose submission journal is applied or ambiguous
  (ambiguous routes to Needs), so skipping during Submit cannot cause a duplicate.
- Editing or deleting a reusable answer now refreshes/removes same-id per-job
  overrides, and the engine prefers a newer bank copy by `updatedAt`, so Settings
  edits take effect instead of being shadowed by a remembered Needs You answer.

### Security

- No remote code, `eval`, `new Function`, telemetry, `innerHTML` with page content, cookie
  access, or password storage. Production paths use the structured logger.
- The built manifest requests `storage`, `alarms`, `sidePanel`, Handshake host
  permissions, and the optional Gemini host requested at runtime. MV3's default content
  security policy is intact.
- The package ships no source maps, test fixtures, docs, or secrets.

### Known limitations

- The application modal, document pickers, My Jobs, and blocked/login detail states were
  not opened during the read-only live capture. Their selectors remain defensive
  fallbacks built from synthetic fixtures and are covered by unit/E2E tests, not live
  observation.
- External ATS applications (Workday, Greenhouse, Lever, Ashby, iCIMS) are handed off, not
  completed.
- Documents must already exist in Handshake; file uploads are not automated.
- Chrome/Chromium desktop only.
- On-device AI availability varies by Chrome build and hardware.
- Handshake UI changes can pause a run with `UI_CHANGED` rather than guessing.
