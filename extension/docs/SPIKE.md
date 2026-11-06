# Phase 0 Live Spike — G2 Gate

**Purpose:** replace assumptions with real Handshake evidence before applying selectors are finalized.

**Owner:** the account owner. The 2026-10-25 read-only capture was explicitly
authorized by the owner and performed by an agent with navigation + DOM reads
only. Any future capture defaults to owner-run unless the owner authorizes the
same read-only scope again.

**Gate:** G2 is signed off only when the fixtures and report answer the open questions in `ARCHITECTURE.md` §22.

---

## 0. Capture record — 2026-10-25

**Status:** partial G2. Search + job detail verified; application modal, documents,
My Jobs and blocked states are still unverified.

- **Operator:** implementation agent, with explicit account-owner authorization for
  read-only capture.
- **Browser:** Google Chrome 155.0.8059.86 on macOS.
- **Tenant:** `app.joinhandshake.com` (school subdomain not tested).
- **Tooling:** a new tab per page plus AppleScript `execute javascript` returning a
  pruned DOM skeleton (tags, `data-*`/`aria`/`role`/`href`, short text). Raw
  captures were kept outside the repo in `/tmp/handshook-capture/` and were not
  committed. One Chrome developer-menu toggle,
  **View > Developer > Allow JavaScript from Apple Events**, was enabled to allow
  the read-only JS evaluation. No other setting was changed.
- **Pages loaded (4):**
  1. `https://app.joinhandshake.com/job-search` (redirects to a saved-search URL
     `/job-search/{selectedJobId}?page=1&per_page=25`)
  2. `https://app.joinhandshake.com/jobs/{id}` — external apply
  3. `https://app.joinhandshake.com/jobs/{id}` — external apply
  4. `https://app.joinhandshake.com/jobs/{id}` — Handshake apply (same posting as
     the split-view detail, which was also read without navigating)
- **Actions taken:** navigation, scrolling and DOM reads only. **No Apply,
  Submit, Save/Favorite, Follow, message, form, upload or modal was clicked.**
  No CAPTCHA, warning, rate limit or logout was shown.

### Confirmed

- Search result cards: `[data-hook="job-result-card | {id}"]`; overlay anchor
  `a[role="button"][aria-label]` with empty text; `href` `/job-search/{id}`.
- Card title: first `div[aria-label]`; employer: first non-empty `span`;
  footer location: `[data-hook="job-result-card-footer"]` (promoted cards prepend
  `Promoted`); salary/type share a `·`-separated line.
- Pagination: `[data-hook="job-search-pagination"]`, icon buttons with
  `aria-label` `next page` / `previous page` and native `disabled`.
- Results announcer: `[data-hook="job-search-results-status-announcer"]`.
- Job detail root: `[data-hook="job-details-page"]`; title `h1`; employer
  `a[href^="/e/"]` (non-empty text); description follows the `Job description`
  heading; fields are unlabelled values in an `At a glance` block classified by
  shape.
- Apply variants observed: `button[aria-label="Apply externally"]` and
  `button[aria-label="Apply"]`. A "Quick Apply" label was **not** observed.
- The job pages are plain DOM — no iframe or shadow root was observed for the
  detail view.

### Not observed

- Application modal contents (never opened): dialog role/portal, document
  pickers, screening questions, submit button, validation.
- Quick-apply-specific label or immediate-submit behavior.
- Applied banner, My Jobs list, closed/not-open pages, login redirect.
- Documents page and its API.
- `/stu/jobs/{id}` network shape.
- Iframe/shadow-root placement of the modal or pickers.

### Sanitization

Fixtures under `tests/fixtures/live/` replace employer names with `Employer A/B/C`,
job IDs with `9000000*`, and remove the account menu, sidebar, school/collection
chips, alumni names/profiles, scripts and styles. No cookies, tokens, emails or
personal data were read or committed.

---

## 1. Safety rules

- Use your own account, in a normal Chrome window.
- **Do not submit an application during capture.** Open modals, inspect, then close/cancel.
- Do not run the Python tool at the same time.
- Do not repeatedly reload or click in rapid succession; browse normally.
- If Handshake shows a warning, CAPTCHA, or rate limit, stop immediately.
- Sanitize every capture before committing it.
- Do not capture cookies, CSRF tokens, passwords, or full resume contents.

---

## 2. What to capture

Capture each page in a **logged-in** state, on the host you actually use (school subdomain or `app.joinhandshake.com`).

Also note whether the application modal lives in an **iframe** or **shadow root**, and whether pickers render in a React portal outside the main app root. The spike report must answer this.

| #   | Page                           | What we need                                                                                      |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1   | Job search results             | URL format, job card DOM, ID links, title/employer/location text, pagination control, empty state |
| 2   | Search page 2                  | Pagination behavior, whether URL/page param changes, duplicate/ordering behavior                  |
| 3   | Quick Apply job                | Button label, page DOM, confirmation behavior, applied banner                                     |
| 4   | Standard Apply job             | Button label, modal DOM, required documents, submit button                                        |
| 5   | Application modal              | Document pickers, search inputs, combobox roles, hidden selects, option labels, validation        |
| 6   | Modal with screening questions | Label/legend/aria patterns, radio/select/text/checkbox, required markers, custom free text        |
| 7   | Apply Externally job           | Button label, popup/instructions, whether docs/questions appear before redirect                   |
| 8   | Profile documents              | Document list DOM/API, IDs, types, titles, filenames                                              |
| 9   | My Jobs / applied job          | Applied banner text, status, URL, how to reconcile                                                |
| 10  | Logged-out/login redirect      | Session detection signals                                                                         |

If a page type doesn't exist on your tenant, note it.

---

## 3. Capture procedure

### 3.1 Browser DevTools

For each page:

1. Open DevTools → Elements.
2. Select the relevant container (job card, modal, question, button).
3. Copy the **outerHTML** of the smallest subtree that preserves labels/roles/attributes.
4. Copy the visible text/labels separately (helps selector tests).
5. Record the full URL (strip query tokens if present).
6. Take a screenshot only if it contains no PII; otherwise skip.
7. For network: DevTools → Network → Fetch/XHR; record method, path, status, and a **shape-only** JSON sample (replace values). Never export cookies/headers.

### 3.2 Capture helper (T07)

`scripts/capture-page.js` is a read-only DevTools Console snippet. It never clicks
an Apply button, submits a form, or navigates. It collects the page URL (query
tokens stripped), detected page type, headings, button labels, form-control
metadata, screening questions, document metadata, iframe/shadow-root/portal
facts, network endpoint shapes, and a sanitized copy of the main content plus any
open dialog.

Before writing anything it redacts emails, phone numbers, the signed-in user's
name, recruiter/greeting names, document filenames (`Resume A.pdf`,
`Cover Letter A.pdf`, ...), CSRF/token values, hidden input values, textarea
contents, inline scripts/styles, token-bearing `data-*` attributes, and image
URLs. Employer names are preserved by default (they are public job data) and can
be anonymized with the option below.

Files:

- `scripts/capture-page.js` — paste this into the Console.
- `scripts/capture-page.bookmarklet.txt` — optional `javascript:` bookmarklet.
- The snippet is generated from `scripts/capture/*.js`; rebuild it with
  `node scripts/capture/build-snippet.mjs` instead of editing the generated file.

#### Prepare (once)

1. Use your own account in a normal Chrome window. Sign in normally; the helper
   never automates login or SSO.
2. Open DevTools (`Cmd+Option+J` on macOS, `Ctrl+Shift+J` on Windows/Linux) and
   select the **Console** tab.
3. Keep that tab focused. Chrome only allows clipboard writes from a focused page.
4. Optional — anonymize employer names as `Employer A`, `Employer B`, ... by
   running this once before the first capture:
   ```js
   window.HANDSHOOK_CAPTURE_OPTIONS = { anonymizeEmployers: true };
   ```
5. Keep your `Downloads` folder handy.

#### Capture the pages

Open one page at a time, wait for it to finish rendering, paste the entire
contents of `scripts/capture-page.js` into the Console, and press Enter. Capture
one file per page state.

| #   | Page                        | How to reach it                                                             | Expected console `Page type` |
| --- | --------------------------- | --------------------------------------------------------------------------- | ---------------------------- |
| 1   | Search results, page 1      | Job search with your normal filters                                         | `search`                     |
| 2   | Search results, page 2      | Click Next once; do not change filters                                      | `search`                     |
| 3   | Quick Apply job             | Open a job whose action says `Quick Apply`                                  | `job-quick`                  |
| 4   | Standard Apply job          | Open a job whose action says `Apply`                                        | `job-form`                   |
| 5   | Application modal           | On that job, click `Apply`, wait for the dialog, then run the snippet       | `modal-basic`                |
| 6   | Modal with questions        | Same modal if it shows screening questions, or find a job that does         | `modal-questions`            |
| 7   | Apply Externally job        | Open a job whose action says `Apply Externally`                             | `job-external`               |
| 8   | Profile documents           | Profile → Documents (or the documents path used by your tenant)             | `documents`                  |
| 9   | My Jobs / applied job       | My Jobs, or an already-applied job detail                                   | `my-jobs` / `job-applied`    |
| 10  | Logged-out / login redirect | Sign out or use a private window, capture the login page, then sign back in | `login`                      |

Rules:

- Do **not** submit an application. For modal captures, close with Cancel/X or
  `Esc` after the snippet finishes.
- If a modal needs clicks to reveal questions or the document picker, make those
  clicks yourself first. The snippet only reads the currently rendered DOM.
- Do not paste twice for the same page state; that produces duplicate files.
- If a page type does not exist on your tenant, skip it and note the absence in
  the spike report.

#### Where the files land

Each run downloads:

```
~/Downloads/handshook-capture-<pagetype>-<YYYYMMDD-HHMMSS>.json
```

The same JSON is copied to the clipboard, and the Console prints a summary with
redaction counts, modal/portal/shadow-root facts, and warnings. If the clipboard
is unavailable (unfocused tab or restrictive policy), the downloaded file is
still complete.

#### Ingest into sanitized fixtures

From the `extension/` directory:

```bash
npm run ingest-capture -- ~/Downloads/handshook-capture-*.json
```

The ingest script:

- re-runs the sanitizer over the HTML and metadata (defense in depth);
- refuses to write a fixture if any email, phone, or token pattern survives;
- writes `tests/fixtures/live/<pagetype>/<name>.html` and `<name>.json`;
- rebuilds that folder's `README.md` with source URL, capture time, and host.

Then run the selector-health test:

```bash
npx vitest run tests/integration/live-selectors.test.ts
```

The suite requires sanitized live fixtures. It prints a per-selector HIT/MISS
report and asserts the adapters can extract job IDs, job title/employer/apply
kind, modal questions, and the document picker.

#### Verify before committing

```bash
grep -RniE 'cookie|csrf|token|secret|session|authorization|@' tests/fixtures/live/
```

Review the fixture diff and the JSON summary, then delete the raw captures from
`Downloads`. If the grep or ingest reports a match, do not commit; re-capture
that page and note the failure in the spike report.

#### Troubleshooting

- **No download appeared:** Chrome may prompt for automatic downloads; allow it.
  The clipboard copy and Console summary still work.
- **Clipboard failed:** the snippet tries a temporary copy field, then reports the
  failure. Use the downloaded JSON.
- **`Page type: unknown`:** the URL is outside the known route set. Capture it
  anyway and record the URL in the spike report.
- **`crossOrigin: true` on an iframe:** the modal lives in a cross-origin frame and
  its inner DOM cannot be read from the page. Record that fact; do not bypass it.
- **`HTML truncated` warning:** the page is unusually large. Capture a narrower
  state (for example the open dialog) or record the truncation as a known gap.

**2026-10-25 update:** the T07 capture was performed with a pruned-DOM JS
snippet rather than this script. The snippet collected `data-*`/`aria`/`role`/`href`
attributes and short text for result cards, pagination, apply controls, and the
job-detail sections. Raw captures stay outside the repository; only sanitized
fixtures are committed under `tests/fixtures/live/`.

### 3.3 Save locations

```
tests/fixtures/live/
  search/
    README.md
    search-page-1.html
    search-page-2.html
    search-meta.json
  job-quick/
  job-form/
  modal-basic/
  modal-questions/
  job-external/
  documents/
  my-jobs/
  login/
```

Each `README.md` records: source URL (sanitized), date, tenant, what it tests, known gaps.

---

## 4. What to record in the report

Answer these explicitly:

1. Search URL patterns and pagination (`page=` vs button vs infinite scroll).
2. Job card structure and how to reliably get the job ID.
3. Detail page fields and their labels; is `/stu/jobs/{id}` available? Shape?
4. Quick Apply: does it submit immediately or open a modal? Confirmation text?
5. Standard Apply modal: dialog role/portal, document pickers, submit button, validation.
6. Screening questions: DOM patterns for label/legend/aria; types seen; required markers; custom free text.
7. External apply: popup/instructions; are docs/questions required before redirect? Does the job show as pending?
8. Documents: how to list IDs/types/titles; is there an API?
9. Applied state: exact banner/text/URL; can we reconcile reliably?
10. Session: logged-out URL/DOM signals; SSO behavior.
11. Tenant differences: school subdomain vs app, UK vs US.
12. Any UI that breaks the proposed flow.

Include a **go/no-go** for each flow:

- Quick Apply autopilot
- Standard form autopilot
- Review mode
- External handoff
- Document discovery

---

## 5. Sanitization checklist

Before committing a fixture:

- [ ] Remove names, emails, phone numbers, addresses.
- [ ] Remove resume/cover letter text and filenames if identifying.
- [ ] Remove cookies, CSRF tokens, auth headers, session IDs.
- [ ] Remove employer names if sensitive (replace with `Employer A`).
- [ ] Remove job IDs if they identify you; replace with `10000001`.
- [ ] Remove tracking/query params.
- [ ] Remove inline scripts (not needed for selector tests).
- [ ] Verify no `token`, `secret`, `session`, `csrf`, `authorization` strings remain.
- [ ] Run a secret scanner/grep over the fixture folder.

```bash
grep -RniE 'cookie|csrf|token|secret|session|authorization|@' tests/fixtures/live/
```

---

## 6. Success criteria

- [ ] At least one fixture per page type (or a documented absence).
- [ ] Three application types are distinguishable from DOM.
- [ ] Document pickers are selectable via at least two strategies.
- [ ] At least one screening-question variant is captured, including a free-text/custom question if present.
- [ ] Confirmation text/state is known.
- [ ] Session/logged-out signal is known.
- [ ] `/stu/jobs/{id}` availability/shape is known.
- [ ] Fixtures pass the sanitization grep.
- [ ] `docs/SPIKE-REPORT.md` has go/no-go per flow.
- [ ] User signs `.handoffs/T07.md`.

---

## 7. Stop conditions

Stop capture and report if:

- Handshake shows a warning/CAPTCHA/rate limit.
- You are asked to re-authenticate unusually.
- A page contains another student's data.
- You cannot sanitize a fixture confidently.
- The UI differs so much that the proposed flow may not be viable — that's a valid finding, not a failure.

---

## 8. Report template

```md
# G2 Spike Report

Date:
Tenant/host:
Chrome version:
Extension build (if used):

## Flow matrix

| Flow                 | Confirmed?     | Evidence | Notes |
| -------------------- | -------------- | -------- | ----- |
| Search discovery     | yes/no/partial | fixture  |       |
| Quick Apply          |                |          |       |
| Standard Apply       |                |          |       |
| Screening questions  |                |          |       |
| External apply       |                |          |       |
| Documents            |                |          |       |
| Applied verification |                |          |       |
| Session detection    |                |          |       |

## Confirmed selectors

- search.jobLink:
- search.nextPage:
- job.title:
- apply.button.quick:
- apply.button.form:
- apply.button.external:
- modal.root:
- documents.resume.trigger:
- documents.resume.option:
- questions.control:
- submit.button:
- confirmation:
- applied.banner:

## Endpoints observed

- GET /stu/jobs/{id}:
- GET /profile/documents:
- GET /my-jobs:
- POST /jobs/{id}/applications:

## Tenant differences

## Unknowns / risks

## Go / no-go

- Quick Apply autopilot:
- Standard form autopilot:
- Review mode:
- External handoff:
- Document discovery:
```
