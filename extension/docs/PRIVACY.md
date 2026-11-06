# Handshook Privacy Policy

**Last updated:** 2026-10-28
**Applies to:** the Handshook browser extension 1.1.4 (unreleased; older-release differences are noted below).

Handshook helps you review and submit job applications on Handshake. It is independent
and is not affiliated with or endorsed by Handshake. There is no Handshook account,
backend, advertising, analytics, or automatic telemetry.

## What is processed and stored locally

The extension reads supported Handshake pages to detect your session, find jobs,
prepare application forms, and check outcomes. Its content script runs on
Handshake pages, including page/session detection; it is not limited to pages you
manually start a run on. It does not collect browsing history outside Handshake.

- **Settings and small state:** saved search URLs, filters, pacing and safety choices,
  document IDs and names, engine state, and onboarding are in `chrome.storage.local`.
- **Application data:** jobs and descriptions, queue/history, submission attempts,
  saved answers (including job-specific answers), document names, diagnostic
  events, selector results, AI match cache, OpenRouter model catalog, and counters
  are in local IndexedDB. A page-assist control locator is remembered locally as well,
  so later pages need no AI call.
- **Document details:** the Handshake document IDs and the names you give them.
  Handshook does not read, list, or refresh your Handshake documents page, and it
  never reads, uploads, or stores the document files themselves.
- **Saved answers:** may contain names, contact details, education, work authorization,
  and other personal information. Sensitive or EEO information, including disability,
  veteran status, race, or gender, is stored only if you choose to save it.
- **Optional OpenRouter key:** stored separately and unencrypted in `chrome.storage.local`, not browser
  sync. It is excluded from diagnostics and backups. Local storage is restricted to
  trusted extension contexts; content scripts cannot read it. The panel sends a new
  key to the background once, then receives status and requested key usage/limit
  metadata, never the saved key itself.
- **Temporary browser-session state:** `chrome.storage.session` holds the runner tab
  ID, run ID, session application count, break deadline, and browser-start marker.
  Chrome clears these on extension reload/update/disable or browser exit. They are
  not synced or exported and are not accessible to content scripts.

Local storage is not encrypted by Handshook. Anyone with access to your browser
profile or exported files may be able to read it. Use your device's security controls.

## Communication with Handshake

“Stored locally” does not mean the extension works without Handshake's servers.
It navigates Handshake pages and makes same-origin GET requests for job details
at `/stu/jobs/{numeric-id}` and, if needed, `/jobs/{numeric-id}` on the current
Handshake origin. JSON reads reject redirects and cross-origin requests and use
the existing browser session. The browser supplies normal session credentials;
Handshook does not read, copy, export, or store your password, cookies, or session tokens.

When Handshook fills a form, the data becomes available to the Handshake page. In the
default automatic mode it clicks Apply, fills Handshake's application dialog, and clicks
Submit Application on your behalf; in Review mode you submit the filled form yourself.
Either way Handshake's normal application flow sends the selected document references and
form answers to Handshake and the relevant employer under their policies. Handshook does
not send application data to a developer-operated server. External employer sites you
choose to visit communicate under their own policies.

## AI matching and page assist

AI is on by default, but it is not a Handshook service and Handshook bundles no key.
Without an OpenRouter key, matching runs locally with keyword scoring and no network
call, and page assist does not run at all. AI is used to choose among the resumes you
entered, with page assist to choose **which page control** to use, with answer assist
to choose **which of your saved answers** a question is asking for, and — only after your
saved answers — to **write an answer** to a question that does not depend on a personal
fact. It never answers questions about your experience, eligibility, history or
demographics, picks a document you did not enter, or decides whether to submit.

### OpenRouter with your own key

When cloud matching is active — a saved key, a selected model, and the optional
permission — Handshook sends matching requests to `https://openrouter.ai`, which forwards
the prompt to the provider serving your chosen model.
OpenRouter replaces the extension's former Gemini integration in 1.1.0. 1.1.0 also
removes the former built-in browser AI model. Automatic provider selection tries
OpenRouter when a key, selected model, and permission are present, then local
keyword matching. Job/resume data is sent only when OpenRouter is the active matcher.

Saving a key, testing, or loading models requests the optional
`https://openrouter.ai/*` permission directly from your click. The background checks
the current grant immediately before every OpenRouter network request, including
retries, model-list refreshes, and key-information lookups. Denying or removing the
grant blocks those requests. Loading models retrieves the text-model catalog;
checking the key retrieves usage/limit information. Neither operation sends job or
resume data. A configured key authenticates these requests.

A matching request contains fixed instructions and:

- The job title, limited to **300 characters**.
- The job description, limited to **2,000 characters**.
- For each resume: its **Handshake document ID** and the **name you gave it**, as
  text. Resume names and IDs can contain personal information.

This metadata can contain personal information if you put it in names or descriptions.
Handshook does not send document file contents, the saved-answer bank, application
history, Handshake passwords, or session cookies in the AI prompt. Your OpenRouter API key
is sent only to OpenRouter in the `Authorization: Bearer` header, not the URL or
Handshake pages. Redirects are refused
and browser cookies are omitted. **Test OpenRouter** also makes a real
request, with fictional matching data rather than your job/resume data, even if matching
is currently disabled. `deepseek/deepseek-v4.1-flash` is preselected for matching and
page assist; you can choose another model or none.

### Page assist (apply-time control lookup)

When Apply, Submit Application, the resume card, or a cover letter/transcript/other
document field cannot be found by Handshook's normal selectors, it can ask the selected
model which of the page's controls to use. This request is separate from resume matching:

- It contains a numbered list of at most **80 candidate controls** from the job page or
  the open application dialog. For each candidate: its tag, role, input type, a short
  accessible **name**, up to 120 characters of visible text, placeholder, or nearest
  label/heading, whether it is inside the dialog, whether it is disabled, and only these
  attribute names: `aria-haspopup`, `aria-expanded`, `aria-label`, `data-hook`,
  `data-testid`, `data-kind`, `data-variant`, `data-size`, and `name`.
- Emails, phone numbers, and runs of seven or more digits in those labels are replaced
  with `[email]`, `[phone]`, and `[digits]` before the request is sent. Input values are
  never read.
- It contains **no** saved answers, form values, document contents, link targets
  (`href`), or page URLs, including the job URL.
- The reply is a candidate number, which Handshook validates against the list it sent;
  a low-confidence answer is treated as "not found". Destructive or unrelated controls
  (withdraw, delete, remove, cancel, upload, close/back, sign out, save, share, preview,
  and similar) or anything outside the job page/application dialog are rejected before
  anything is clicked.
- Every document, question, submit-authorization, and confirmation check still runs
  exactly as it does without AI.

The background remembers a model pick locally — the three most recent per target and
Handshake host, as a tag/role/name/attribute signature — and tries a matching signature
before any network call, so the same markup needs no further AI call. It is only a
shortcut: the full safety and verification rules still apply. **AI page assist** can be
turned off separately in Settings → AI; a control that cannot be found then follows the
normal `UI_CHANGED` / Needs You path.

### Answer assist (saved-answer matching)

When an application question is worded differently from every saved answer — for
example "What is your overall grade point average?" against your saved **Cumulative GPA**
— Handshook can ask the selected model which saved answer the question is asking for:

- It contains up to **20 questions** from the open application dialog: each question's
  label (up to 300 characters), its type, its section heading, and the labels of its
  choices. These are the employer's own form text.
- It contains your saved answers' **labels, aliases, types and categories only** — never
  their values. Your GPA, dates, locations and every other answer stay on this device.
- The reply names a saved answer for each question, or "none". Handshook checks the id
  is one of yours, ignores a low-confidence reply (sensitive questions such as work
  authorization or sponsorship need a higher confidence), and confirms your saved value
  fits the question's choices before filling it.
- The per-answer automatic switch, the sensitive, EEO and free-text switches, and every
  question, submit-authorization and confirmation check still apply.

A confirmed match is remembered locally (question wording and type → saved answer, up to
200), so the same question needs no further AI call. Turn **Let AI match differently
worded questions to your saved answers** off in Settings → AI; questions it cannot match
then wait in Needs You, as before.

### AI-written answers (after your saved answers)

When no saved answer covers a question, Handshook can ask the selected model to write
one — only for questions that do not depend on a personal fact, such as "How did you hear
about this position?" or "Why are you interested in this role?":

- Before any request, Handshook removes questions about work authorization, sponsorship,
  salary, self-identification (EEO), experience or skills, education, dates and
  availability, history, contact details and similar personal facts. Those always wait
  for your own answer. Free-text questions also need the free-text switch.
- The request contains those remaining questions (label, type, section, choice labels),
  the job's title, employer and up to 2,000 characters of its description, and your
  **non-sensitive** saved answers as facts (for example major, school, degree, graduation
  date, preferred location). Work authorization, sponsorship, salary and EEO answers are
  **never** sent.
- The model must answer "none" unless the job posting, those facts or common knowledge
  fully support an answer. Handshook keeps only answers above a confidence floor, a choice
  only if it is exactly one of the form's options, and text only within a length limit.
- Every written answer is listed in **Activity** for that job and kept locally with the
  job; diagnostics exports exclude it.

Turn **Let AI answer questions your saved answers don't cover** off in Settings → AI to
stop sending these requests.

### Questions to answer

Questions Handshook meets and cannot answer are kept locally — the form's own wording,
type and choices, and the IDs of the last few jobs that asked — so you can answer each
once in **Settings → Answers**. In a Dry run, Handshook may open an application form to
read its questions, but only when the Apply control declares that it opens a form; it
never fills, selects or submits anything there.

Handshook defaults to `provider.data_collection: 'deny'`, excluding providers that
collect data under OpenRouter's routing policy. **Allow providers that may store or
train on job text** is off by
default; some free models have no eligible provider unless you explicitly enable it.
This routing preference is not a promise of zero retention. The separate
**Zero-data-retention providers only** option is off by default and, when enabled, requires an
eligible ZDR endpoint. Your OpenRouter account settings and the selected provider's
policies also apply. See OpenRouter's [provider data policies](https://openrouter.ai/docs/guides/privacy/provider-logging)
and [zero-retention guidance](https://openrouter.ai/docs/guides/features/zdr).

OpenRouter and the model provider process requests under their own terms and
policies, including OpenRouter's [privacy policy](https://openrouter.ai/privacy)
and [terms](https://openrouter.ai/terms). Costs are billed by OpenRouter to you;
optional fallback models can charge their own rates. Handshook does not collect
payment details or control provider retention. Avoid sensitive resume names.
Turn off AI and remove the key to stop future cloud matching; removing it locally
does not revoke it at OpenRouter or delete earlier requests.

On update, stored Gemini keys are deleted, not converted into OpenRouter keys. Old
backup settings are migrated, but credentials are never imported. To resume cloud
matching and page assist, add an OpenRouter key and grant its new permission; a model is
preselected but can be changed.

## Permissions

| Permission                                                                                     | Purpose                                                                                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `storage`                                                                                      | Save settings, engine/onboarding state, and the optional OpenRouter key locally.       |
| `alarms`                                                                                       | Schedule the next run/verification step or pacing break while the browser is running.  |
| `sidePanel`                                                                                    | Display Handshook's controls beside the page and open them from the toolbar.           |
| `https://*.joinhandshake.com/*`, `https://joinhandshake.com/*`, and their `.co.uk` equivalents | Read and operate supported Handshake pages using your session.                         |
| Optional `https://openrouter.ai/*`                                                             | Send OpenRouter matching, page assist, tests, and model/key lookups when you use them. |

The generated manifest requests no `cookies`, `history`, `webRequest`, `debugger`,
`nativeMessaging`, `downloads`, or `<all_urls>` permission. The extension bundles
its executable code; it does not load remote scripts. Data returned by an AI service
is treated as data and validated.

## Exports and support

Exports are downloaded to your device, not automatically uploaded to the project.

- **Backup JSON** contains settings, saved answers, the document IDs and names you
  entered, jobs, and tracker data. **Applications CSV** contains application
  records. Both can contain personal information and should be kept private.
- **Shareable diagnostics in 1.1.0** use an explicit safe-field projection: status
  codes, settings flags (booleans/numbers/enums), counters, and selector keys. Event
  message text, search URLs/keywords, company/job/document names, answers, and
  credentials are removed. The private backup preserves searches, answers, document
  IDs/names, and history, but excludes the OpenRouter key and session material.
- **Earlier releases:** diagnostics may include raw settings, URLs, identifiers, and
  free text despite pattern-based event redaction. Inspect older files particularly
  carefully. Neither export type should be treated as an unconditional anonymity guarantee.
- Always inspect and remove personal details before sharing diagnostics or screenshots.
  If unsure, send only a written description. Never attach backups, resumes, credentials,
  cookies, or HAR/network captures to a public issue.

If you voluntarily post a support issue, the hosting service receives what you post,
and it may be public. See [safe bug-report instructions](./FAQ.md#report-a-bug-safely).

## Retention and deletion

Local records remain until you delete/reset them or remove the extension, with bounded
event/cache storage (up to 5,000 events and 2,000 AI cache entries). Clearing Diagnostics
removes events and selector history, not the full application history.

**Settings → Your data → Reset local data** stops the run, clears the scheduled engine
alarm and saved OpenRouter key, deletes local application data, and resets settings and
onboarding. If another page holds the database open, reset can fail; resolve the error
before treating deletion as complete. Resetting also removes duplicate-protection
history and resets session pacing/run state. An existing runner tab and its session-only
tab ID/browser-start marker can remain until the browser session ends. Reset does not
revoke Chrome's optional OpenRouter host grant; manage that permission in Chrome. It
does not withdraw submitted applications or remove files from Handshake.

Removing the extension deletes its browser-managed local storage under the browser's
uninstall behavior. Files you downloaded (backups, CSV, diagnostics, and the unpacked
extension folder) remain until you delete them separately. Previously sent information
at Handshake, employers, OpenRouter, or model providers is governed by those services' retention policies.

## Sharing and purpose

Handshook does not sell data, use it for advertising, or send analytics/remote error
reports. Data is used for the application assistance you request, including the
Handshake form interactions and optional OpenRouter requests described above.
There is no cross-device synchronization by Handshook.

Handshook's use and transfer of user data complies with the Chrome Web Store User Data
Policy, including its [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Data is used only for the disclosed application-assistance purpose. The project has
no service that receives application data or lets its staff read it; voluntary support
messages are limited to the information you choose to share.

## Changes and contact

Material policy changes will be reflected in the date above and the
[changelog](../CHANGELOG.md). This policy is for the extension, not the older Python
CLI. The owner maintains the policy and support destinations in the
[distribution-links table](./STORE.md#distribution-links); public hosting is an owner
release prerequisite. For private beta help, contact the owner who supplied your ZIP.
