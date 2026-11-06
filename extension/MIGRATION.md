# Python → Extension Migration Map

This is the parity checklist for moving Handshook from Python/Selenium to the browser extension. The Python tool remains the reference implementation; it is not deleted in v1.

**Source snapshot:** current `main` at `5777c14` (4,339 LOC Python across 7 modules).

---

## 1. What changes in the architecture

| Aspect           | Python                                              | Extension                                                      |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Runtime          | Python process + ChromeDriver + Chrome              | Chrome MV3 + user's Chrome                                     |
| Session          | Extract/decrypt cookies or auto-login with password | Browser's existing session                                     |
| Browser identity | Selenium with stealth patches                       | The user's real browser                                        |
| Job discovery    | Selenium saves HTML; regex extracts IDs             | Live page DOM + SPA routing                                    |
| Apply path       | API POST first, browser fallback                    | UI-first, API for details only                                 |
| State            | JSON/CSV files in repo folders                      | IndexedDB + `chrome.storage.local`                             |
| UI               | Terminal logs + countdowns                          | Side panel with queue/needs-you                                |
| Scheduling       | Sequential Python loop with `sleep`                 | Runner tab + persisted queue + alarms                          |
| Config           | `conf.json` + `.env` + `secrets.json`               | Onboarding + Settings; optional legacy import                  |
| AI               | Gemini via `google-genai` SDK (legacy Python only)  | Local heuristic; optional OpenRouter with the user's key/model |
| Distribution     | Git clone + pip                                     | Chrome Web Store / ZIP                                         |
| Password/cookies | Stored/exported                                     | Never requested                                                |

---

## 2. Module-by-module mapping

### `handshake.py` → `src/handshake/*` + `src/core/orchestrator/*`

| Python                                                                | Current behavior                                            | Extension equivalent                                                     | Notes                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `HOST = env HANDSHAKE_HOST`                                           | Single host                                                 | `src/handshake/host.ts` detects `location.hostname`; settings store host | Wildcard manifest; per-school host    |
| `get_csrf_token(session)`                                             | GET homepage, parse meta                                    | `src/handshake/jobDetails.ts` (only if a POST is ever needed)            | UI-first path avoids POST/CSRF        |
| `Job.__init__`                                                        | Parses `job_id`, `job_name`, `employer_name`, `apply_start` | `Job` contract + `src/handshake/jobDetails.ts`                           | String IDs                            |
| `Job.fetch_details`                                                   | GET `/stu/jobs/{id}`, `/jobs/{id}`                          | `jobDetails.ts` DOM + same-origin fetch                                  | Keep 403/422 fallback                 |
| `Job.apply`                                                           | POST `/jobs/{id}/applications` with doc IDs                 | `applyFlow.ts` UI-first                                                  | Direct POST documented fallback only  |
| `Job.apply` status codes 0–5                                          | success/cookie/waiting/external/docs/fetch                  | `ApplyOutcome` + `AppError`                                              | Explicit, typed outcomes              |
| `Job.wait` / `waiting`                                                | Wait list for future open                                   | `waiting` status + `nextAttemptAt`                                       | Queue-driven                          |
| `Job.write`                                                           | CSV line                                                    | IndexedDB + export                                                       | Same fields plus status/reason        |
| `process_profile`                                                     | Sequential profile loop                                     | `engine.ts` + `queue.ts`; one active search profile                      | Multi-profile deferred                |
| `read_conf`                                                           | `PROFILES` / single profile                                 | `settings.search.savedSearches` + migration                              | No cookies                            |
| `sanitize_url`                                                        | Removes `page`, `ref`, UTM                                  | `host.ts`/`urls.ts` + tests                                              | Port test `test_sanitize_url`         |
| `check_and_extract_html`                                              | Manual HTML save → IDs                                      | `discovery.ts`                                                           | No HTML files                         |
| `identifier.extract_ids_from_html`                                    | Regex + >10M filter                                         | `discovery.ts` URL-context extraction                                    | Avoid magic threshold; spike confirms |
| CLI flags (`--dry-run`, `--no-browser`, `--prune-tracker`, `--debug`) | Flags                                                       | Settings + UI: review/dry-run, mode, prune, diagnostics                  | No CLI                                |
| `get_csrf_token` dependency on requests                               | `requests.Session`                                          | Content script same-origin fetch                                         | Cookies automatic                     |

**Documented API fallback (do not use for normal flow):**

```json
{
  "application": {
    "applicable_id": 12345678,
    "applicable_type": "Job",
    "document_ids": [111, 222]
  },
  "work_authorization_status": null
}
```

- Endpoint: `POST /jobs/{id}/applications`
- Headers: `X-CSRF-Token` (meta tag), `Content-Type: application/json`
- Only if the UI path cannot be used and the job is a verified Quick Apply; never for custom questions.

---

### `browser_automation.py` → mostly deleted; apply DOM ported

| Python area                                                                                           | Lines (approx) | Decision           | Extension equivalent                                              |
| ----------------------------------------------------------------------------------------------------- | -------------: | ------------------ | ----------------------------------------------------------------- |
| `AuthManager` (5-source cookie extraction)                                                            |         69–536 | **Delete**         | Browser session                                                   |
| Browser cookie paths / platform detection                                                             | 30–67, 180–535 | **Delete**         | —                                                                 |
| `get_chrome_cookies`, `is_chrome_running`, `find_chrome_binary`, `get_chrome_user_data_dir`, profiles |        538–623 | **Delete**         | —                                                                 |
| `load_cookies_to_driver`                                                                              |        624–637 | **Delete**         | —                                                                 |
| `automate_browser` (Selenium, stealth, HTML save)                                                     |       638–1099 | **Delete/replace** | `discovery.ts` + `content/lifecycle.ts`                           |
| Stealth JS / `navigator.webdriver` patches                                                            |        770–830 | **Delete**         | Real browser                                                      |
| Human scroll/mouse/delays                                                                             |        867–930 | **Delete**         | Pacer + normal page use                                           |
| `try_auto_login`                                                                                      |      1100–1223 | **Delete**         | User logs in; `detectSession` pauses                              |
| `update_conf_file` (cookies)                                                                          |      1224–1248 | **Delete**         | —                                                                 |
| `apply_to_jobs_via_browser`                                                                           |      1249–2040 | **Port**           | `applyFlow.ts`, `documents.ts`, `questions.ts`, `verification.ts` |
| Apply button discovery / external detection                                                           |      1477–1571 | Port               | `applyType.ts` + `applyFlow.ts`                                   |
| Modal detection                                                                                       |      1594–1610 | Port               | `selectors/apply.ts`                                              |
| Work auth hardcoded Yes / sponsorship No                                                              |      1633–1666 | **Replace**        | Answer bank + explicit opt-in                                     |
| Resume dropdown 3 strategies                                                                          |      1668–1770 | Port               | `documents.ts`                                                    |
| Transcript dropdown 3 strategies                                                                      |      1772–1874 | Port               | `documents.ts`                                                    |
| Cover letter dropdown 3 strategies                                                                    |      1876–1970 | Port               | `documents.ts`; remove hardcoded name hint                        |
| Submit button selectors                                                                               |      1972–2010 | Port + verify      | `verification.ts`                                                 |
| 90–120s sleep between jobs                                                                            |      2013–2018 | Port               | `pacer.ts` (60–120s, jitter)                                      |
| Ephemeral/persistent Chrome profile cleanup                                                           |      2020–2040 | **Delete**         | —                                                                 |

**Important bugs/risks to not carry over:**

- Hardcoded `cover_title_hint = "Prakash"` — removed; selection must be ID/title from user settings.
- Hardcoded work authorization/sponsorship answers — replaced with explicit user answers.
- "Pick first available" document fallback for required docs — removed; required docs must match or pause.
- Reporting `results[job_id] = True` immediately after clicking Submit without verification — replaced with confirmation verification + reconciliation.
- Stealth patches (`navigator.webdriver`, plugins, platform) — removed; real browser only.
- Cookie extraction/decryption — removed entirely.

---

### `resume_matcher.py` → `src/ai/*`

| Python                                                  | Extension equivalent                                               | Notes                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `RESUMES` from conf                                     | `ResumeOption[]` from documents settings                           | Auto-detected documents                    |
| `match_resume_with_ai(title, description)`              | `matcher.ts` `match()`                                             | Provider orchestration                     |
| Prompt with three hardcoded rule lines                  | `prompts.ts` generic + examples                                    | No hardcoded resume titles                 |
| Gemini client, model `gemini-2.0-flash` (legacy Python) | `providers/openrouter.ts` with the user's key                      | User chooses a model; no preselected model |
| `temperature 0.1`, `top_p 0.95`, max 20 tokens          | Temperature 0, about 400 output tokens; strict JSON when supported | Validate resume allowlist                  |
| Regex `\d+` extraction                                  | Zod JSON `{resumeId, confidence, reason}`                          | Allowlist check                            |
| Fallback to first resume                                | Heuristic/default + low confidence                                 | No silent first pick                       |
| SHA-256 exact cache                                     | `cache.ts` same key concept                                        | Add resume set to key                      |
| 1s rate limit                                           | Provider rate limit                                                | 1 req/s                                    |
| `_apply_rate_limit` sleep                               | Abortable delay                                                    | Background context                         |

**Prompt parity:** keep the intent (choose best resume from the provided list), but make it strict JSON and treat the job description as untrusted. Do not include rule lines referencing specific resume titles.

**Extension 1.1.0 provider migration:** settings load/import maps legacy `gemini` to
`openrouter`, deletes stored Gemini keys, fills default routing settings, and shows
a one-time notice. Credentials are not imported. Add an OpenRouter key, grant the
optional OpenRouter origin, and choose a model to restore cloud matching. Default
provider routing denies data collection; local matching remains available.

---

### `rate_limiter.py` → `src/core/orchestrator/pacer.ts` + `guards.ts`

| Python                                        | Extension                                          | Notes                                     |
| --------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `DEFAULT_CONFIG` 60/120/50/10/300/600/10%     | `DEFAULT_SETTINGS.pacing` 60/120/25/10/300/600/10% | Daily cap lowered to 25                   |
| `can_apply_today`                             | `pacer.canApplyToday`                              | Local date keyed                          |
| `wait_before_apply` + `_countdown`            | `pacer.nextDelay`/`sleep`                          | No terminal countdown; UI shows countdown |
| Session break every 10                        | Same                                               | 5–10 min                                  |
| Exponential backoff 2^n cap 16×               | Same                                               | Honor `Retry-After`                       |
| `record_application` success-only daily count | Same                                               | Errors separate                           |
| `record_error`/`reset_errors`                 | `guards`/engine                                    | Consecutive failures                      |
| `stats_file` JSON                             | IndexedDB `meta` daily counts + events             | Export                                    |
| No active hours                               | Add 08:00–22:00 default                            | Configurable                              |
| No hard cap                                   | Add hard cap 100                                   | Below Handshake 300 block                 |
| No rate-limit signal handling                 | Add 429/403 pause                                  | New                                       |

---

### `job_tracker.py` → `src/core/storage/tracker.ts` + `jobs.ts`

| Python                                                                          | Extension                         | Notes                                                       |
| ------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| Categories `applied`, `external`, `skipped`, `unsupported`, `failed`, `waiting` | `JobStatus` + tracked job records | Add `filtered`, `needs_input`, `already_applied`, `blocked` |
| `PERMANENT_CATEGORIES` applied/external/unsupported                             | `TerminalJobStatus` + policy      | Matches                                                     |
| `is_tracked` only permanent                                                     | `isTracked` same                  | Skipped reprocessable                                       |
| `track_*` methods                                                               | repository functions              | Idempotent                                                  |
| `prune` external/unsupported/skipped older than N days                          | `prune` same                      | Never applied                                               |
| `matches_skip_keywords` title-only                                              | `filters.ts` title+description    | Improved                                                    |
| `matches_job_keywords`                                                          | `filters.ts`                      | Improved                                                    |
| `set_dry_run_mode` global                                                       | `RunMode` `dry_run`/`review`      | No global mutable                                           |
| JSON file `logs/job_tracker.json`                                               | IndexedDB                         | Import/export                                               |
| Session stats                                                                   | `QueueSummary` + events           | UI                                                          |

**Status mapping for import:**

| Python category | Extension status                                      |
| --------------- | ----------------------------------------------------- |
| `applied`       | `applied`                                             |
| `external`      | `external`                                            |
| `unsupported`   | `blocked` (reason: missing unsupported document type) |
| `skipped`       | `skipped`                                             |
| `failed`        | `failed` (retryable)                                  |
| `waiting`       | `waiting` (nextAttemptAt from open date)              |

---

### `identifier.py` → `src/handshake/discovery.ts`

| Python                                                                         | Extension                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `validate_job_id` numeric > 0                                                  | `parseJobId` numeric string > 0                                  |
| `validate_job_title` trim                                                      | `normalizeTitle`                                                 |
| `extract_ids_from_html` regex `/stu/jobs/`, `/jobs/`, `data-job-id`, `"jobId"` | `discovery.ts` reads live DOM/anchors; no HTML files             |
| `> 10_000_000` filter                                                          | Remove; validate by URL context + numeric range. Spike confirms. |

---

### `config_loader.py` + `conf.json.template` → `src/core/storage/settings.ts` + migration

| Python key                            | Extension setting                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `RESUMES`                             | default resume ID/name, up to 5 additional named resumes; names feed AI matching  |
| `COVER_LETTER_ID`                     | `documents.coverLetterId`                                                         |
| `TRANSCRIPT_ID`                       | `documents.transcriptId`                                                          |
| `URL_LIST`                            | `search.savedSearches[]`                                                          |
| `SKIP_KEYWORDS`                       | `search.excludeKeywords`                                                          |
| `JOB_KEYWORDS`                        | `search.includeKeywords`                                                          |
| `RATE_LIMIT_CONFIG`                   | `pacing.*`                                                                        |
| `USER_NAME`                           | not needed (no filename hint)                                                     |
| `CHROME_PROFILE`, `PREFERRED_BROWSER` | deleted                                                                           |
| `COOKIES`                             | deleted                                                                           |
| `PROFILES`                            | import first profile as active search; preserve others in `legacyProfiles` (v1.1) |
| `DATE`, `URL`                         | search URL / timestamps                                                           |

---

### Tests → `tests/`

| Python test                    | Extension test                                                             |
| ------------------------------ | -------------------------------------------------------------------------- |
| `tests/test_identifier.py`     | `tests/unit/discovery.test.ts` (ID parsing)                                |
| `tests/test_config_loader.py`  | `tests/unit/settings.test.ts` + `migration.test.ts`                        |
| `tests/test_job_tracker.py`    | `tests/unit/tracker.test.ts`                                               |
| `tests/test_sanitize_url.py`   | `tests/unit/urls.test.ts`                                                  |
| `tests/test_resume_matcher.py` | `tests/unit/matcher.test.ts`                                               |
| 56 tests total                 | Port equivalent + new coverage for pacer, answers, apply flow, engine, E2E |

**No test may hit the live site.** Use fixtures/mocks.

---

## 3. Behavior parity checklist

### Must match

- [ ] Job ID extraction handles `/jobs/{id}`, `/stu/jobs/{id}`, `data-job-id`, `"jobId"`.
- [ ] 403 on details → continue with DOM / skip safely.
- [ ] 422 on `/stu/jobs` → try `/jobs`.
- [ ] `apply_type !== "handshake"` → external, terminal.
- [ ] `apply_start` future → waiting.
- [ ] Document type IDs: 1 resume, 2 cover letter, 3 transcript, 5 other.
- [ ] Required document missing → do not submit.
- [ ] Applied/external/unsupported are terminal; failed/waiting retryable.
- [ ] Daily count increments on success only.
- [ ] Skip keywords case-insensitive, title (and now description).
- [ ] AI picks among the default and additional resumes you configured; cache by job text + resume IDs/names.
- [ ] 60–120s delay, 10-app session break, 5–10 min break, jitter.
- [ ] Dry-run/review mode never submits.

### Must improve (intentional differences)

- [ ] Daily cap 25 default, hard cap 100 (Python 50, no hard cap).
- [ ] Work authorization/sponsorship are user answers, not hardcoded.
- [ ] Cover letter selection by ID/title, no name hint.
- [ ] Required documents never fall back to "first available."
- [ ] Submission success requires confirmation, not just a click.
- [ ] No password/cookie storage.
- [ ] No `navigator.webdriver` spoofing.
- [ ] No Selenium/ChromeDriver/profile management.
- [ ] No manual HTML save requirement.
- [ ] Screening questions detected and handled (Python didn't).
- [ ] Active hours + 429/403 handling.
- [ ] Crash-safe write-ahead and reconciliation.
- [ ] AI never silently falls back to the first resume; low confidence is surfaced.

---

## 4. Legacy data import

### `conf.json`

Read-only, local file picker. Import:

- `RESUMES[]` → the default resume plus up to `MAX_ADDITIONAL_RESUMES` (5) named
  additional resumes, keyed by the legacy ID; the legacy title becomes the document
  name used for display and AI matching. Extra entries beyond the cap are reported,
  not stored.
- `COVER_LETTER_ID`, `TRANSCRIPT_ID` → settings.
- `URL_LIST[]` → saved searches.
- `SKIP_KEYWORDS`, `JOB_KEYWORDS` → filters.
- `RATE_LIMIT_CONFIG` → pacing, clamped to extension limits (daily ≤ hard cap, delays ≥ 30s).
- `PROFILES[]` → first enabled profile active; preserve the rest in `legacyProfiles` for future.

Never import `COOKIES`, passwords, API keys, or `.env`.

### `job_tracker.json`

Map categories to statuses (table above). Preserve `applied_at`/`recorded_at` as `updatedAt`. Never import `failed` as terminal. Record an event `migration.imported` with counts.

### `rate_stats_*.json`

Import only today's `daily_counts[YYYY-MM-DD]` into `meta` so the extension doesn't over-apply on the first day. Import `total_applications` for display. Do not import history beyond last 100 (optional).

### `secrets.json` / cookies

**Never import.** Show a migration note: "Cookies and passwords are no longer needed; the extension uses your browser session."

### Implementation notes (T33)

The import screen lives at **Settings → Import & export**. It accepts a JSON file with auto-detection (or an explicit file type) and shows a preview before anything is written. Parsing and storage are separated: `src/core/migration/parse.ts` is pure and Zod-validated; `src/core/migration/apply.ts` merges into the existing settings/tracker repositories. The background re-parses the raw file, so the UI preview is never trusted as data.

| Legacy input                                                            | Extension result                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESUMES[].id/title`                                                    | One default resume (`defaultResumeId`/`defaultResumeName`) plus up to 5 `additionalResumes` `{ id, name }`; the title becomes the name. Entries without a usable ID are skipped with a warning; extras beyond 5 are reported, not stored. |
| `COVER_LETTER_ID`, `TRANSCRIPT_ID`, `OTHER`                             | `settings.documents.{coverLetterId,transcriptId,otherDocumentId}` with matching names; an ID absent from `RESUMES` is still stored with an empty name.                                                                                    |
| `URL_LIST[]`, profile `url`                                             | `settings.search.savedSearches[]` with stable `legacy-search-<hash>` IDs; duplicate URLs are skipped.                                                                                                                                     |
| `JOB_KEYWORDS`, `SKIP_KEYWORDS`, profile `job_keywords`/`skip_keywords` | `settings.search.includeKeywords` / `excludeKeywords` (profile lists win; deduped, capped at 300).                                                                                                                                        |
| `RATE_LIMIT_CONFIG`                                                     | `settings.pacing.*`: delays clamped to 30–600 s, `daily_limit` to 1–100 (`hardCap` 100), jitter to 0–50%. `enabled`/active hours are not imported.                                                                                        |
| `PROFILES[]`                                                            | First enabled/active profile only (its `resume`/`cover`/`transcript`/`other`, URL, and keyword lists). Other profiles are reported, not stored.                                                                                           |
| `COOKIES`, `API_KEY`, `password`, profile `cookies`                     | Never copied, logged, or previewed; only the key names are reported.                                                                                                                                                                      |
| `job_tracker.json` categories                                           | `applied → applied`, `external → external`, `unsupported → blocked`, `skipped → skipped`, `failed → failed`, `waiting → waiting` (with `nextAttemptAt` from `open_date`).                                                                 |
| Tracker timestamps                                                      | `applied_at`/`recorded_at` → `updatedAt` and (for new rows) `addedAt`; missing/unparseable values fall back to import time.                                                                                                               |
| `rate_stats_*.json`                                                     | Only today's `daily_counts[YYYY-MM-DD]` is written to `meta`, and only if it raises the current count. `total_applications` is kept as `legacyTotalApplications`.                                                                         |

Safety rules:

- Every tracker write is an upsert keyed by `jobId`, so re-importing the same file creates no duplicates.
- A terminal status already in the extension (`applied`, `external`, `already_applied`, `skipped`, `filtered`, `blocked`) always wins. An imported `applied` row can never become `failed`/`waiting`; a retryable extension row may be upgraded by an imported terminal row.
- A row older than the extension's own `updatedAt` does not overwrite it.
- Duplicate job IDs across tracker categories keep the higher-priority status (`applied` > `external` > `unsupported` > `skipped` > `waiting` > `failed`).
- Importing a file emits `migration.imported` with counts only — never file contents.

Exports:

- **Applications CSV** (`handshook-applications-YYYY-MM-DD.csv`): applied, already-applied, and external rows only, newest first, with CSV quoting. Columns: `job_id,status,title,employer,url,host,applied_at,attempts`.
- **JSON backup** (`handshook-backup-YYYY-MM-DD.json`): `format: "handshook-backup"`, `version: 1`, settings, answers, document IDs/names, jobs, and tracker entries. AI keys are not read. The file is accepted by the same import screen, so it round-trips.

---

## 5. Legacy cutover

1. Do **not** uninstall or modify the Python repo until the extension passes live smoke.
2. Run both tools on separate days; never the same account simultaneously.
3. Import history once; the extension dedupes by job ID.
4. Keep Python as a reference/CLI for power users; no shared state.
5. After 30 days of stable extension use, archive the Python tool with a README pointer.

---

## 6. What we are deliberately not porting

| Removed                             | Why                            |
| ----------------------------------- | ------------------------------ |
| Cookie extraction/decryption        | Browser session; security risk |
| HAR parsing                         | Unnecessary                    |
| Chrome profile detection/launch     | Unnecessary                    |
| ChromeDriver download               | Unnecessary                    |
| `navigator.webdriver` patches       | Real browser                   |
| Auto-login/password storage         | Security; SSO friction         |
| Manual HTML save workflow           | Live DOM                       |
| Filesystem paths/log folders        | Storage/UI                     |
| Global mutable dry-run flag         | Settings/state                 |
| Hardcoded cover-letter name hint    | Personalized assumption        |
| Hardcoded work-auth answers         | Legal/attestation risk         |
| "First available" required document | Wrong-document risk            |
| Click-submit-without-verify         | Duplicate/false success risk   |

---

## 7. Migration risks

| Risk                                                          | Mitigation                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Extension selectors differ from assumptions                   | G2 live spike + fixtures                                                                           |
| Existing users' resumes not auto-discovered                   | Paste each document link/ID in setup; legacy import fills the default + up to 5 additional resumes |
| Job tracker timestamps/timezones                              | Normalize to epoch ms; document                                                                    |
| Imported filters too broad/narrow                             | Preview counts before import                                                                       |
| Users expect 50/day                                           | Explain 25 default + configurable up to 100                                                        |
| Python and extension double-apply                             | Cutover rule; dedupe import; don't run both                                                        |
| Additional resumes lost when the old document list is removed | Re-enter up to 5 named IDs; default/cover/transcript IDs survive                                   |
| Legacy profiles                                               | Import first; defer multi-profile                                                                  |

---

## 8. Cutover acceptance

- [ ] Import `conf.json` + `job_tracker.json` + `rate_stats` on a real setup.
- [ ] Applied count matches; no job becomes retryable.
- [ ] First scan finds jobs and excludes imported applied IDs.
- [ ] Review-mode application uses the right resume/doc.
- [ ] No cookie/password file is read.
- [ ] Python tool still runs independently (unchanged).
