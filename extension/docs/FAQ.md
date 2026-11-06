# FAQ and troubleshooting

[Install and first run](./INSTALL.md) · [Privacy policy](./PRIVACY.md) ·
[Support link](./STORE.md#distribution-links)

## Handshook says I am not logged in

Open Handshake in a normal tab in the **same browser profile** and sign in normally.
Complete any school sign-in or verification yourself. Refresh the Handshake tab,
then click **Check session** again while on setup's session step; expect **Signed in
on this browser**. After setup, use **Home → Resume** if paused, or start a new run if
stopped. Check **Settings → Search → Handshake host** for the correct
US/UK host and click **Save**. Settings becomes available after setup; if the setup
host is wrong, continue without starting a run, correct it in Settings, then re-enter
your document links before starting. If a challenge or account warning persists, stop; do not
keep retrying. Handshook does not need your password or exported cookies.

## The side panel does not open

Use current desktop Chrome (minimum 120; check **`chrome://settings/help`**).
Edge/Brave panel behavior is not yet validated. On **`chrome://extensions`**, enable
Handshook and check for an error. Open Chrome's puzzle-piece **Extensions** menu,
pin **Handshook**, then click its toolbar icon (tooltip **Open Handshook**). You can
also click Handshook in the Extensions menu without pinning it. The ZIP file itself
does not open the panel. If **Load unpacked** says the manifest is missing, select
the extracted folder containing `manifest.json`, not its parent folder or the ZIP.
After an update, reload the extension
and refresh the Handshake tab. A managed school/work browser may block developer
extensions; ask its administrator rather than trying to bypass the policy.

## The run paused with “Page changed” or `UI_CHANGED`

Handshook could not confidently identify a page control. If **AI page assist** is on with
an OpenRouter key, it has already tried the model and the safety vetoes; a control it
could not identify or safely accept still pauses rather than guessing. Stop the run and
check for a newer release. Reload the extension and refresh the page after updating. If the
problem persists, use [Report a bug safely](#report-a-bug-safely). Do not repeatedly
retry a job that might already have submitted; check Handshake's application history.

## Why does an external job need me?

Some jobs send you to an employer's site, such as Workday or Greenhouse. Handshook
does not complete those forms or navigate its runner to those sites. Finish them yourself using the link in the job
posting. In **Queue**, look for **Employer site** and choose **Open posting**.
That status (called `external` in exported records) is a handoff, not a successful
application. It does not increase your applied count. A run containing only an
external job may finish as **Idle** without showing a Stop button.

## Handshook cannot find or select a document

Handshook does not read, list, or refresh your Handshake documents page. You tell it
which documents to use by pasting a link or ID: click the link to your Handshake
documents page in setup or **Settings → Documents**, open the file, and copy either its address
(`https://app.joinhandshake.com/docs/12345678`) or the numeric ID at the end of it.
Paste it into the right field; an unparseable or non-Handshake link is rejected
rather than guessed. Give each document a name you recognize, because Handshook
cannot read file contents to tell similar files apart, and a name is only a label
for you.

If a required document has no ID, the job waits in **Needs you** with no submission.
Upload the file on Handshake, re-enter its link, then retry. Optional types such as
cover letter or transcript can be left blank. To let automatic matching choose
between resumes, enter up to five **additional resumes** with their own IDs and
names; matching and per-job choices may use only the resumes you entered. If the
selected file is wrong, correct the ID in **Settings → Documents → Save** and use
**Skip** on an unfinished review rather than submitting with the wrong file.

AI page assist can help Handshook find the document field itself, but it never chooses
or invents a document: the file is still the ID you entered. If the field is found and
your ID is not in its picker, the job waits in **Needs you**.

Never submit with a wrong document just to advance the queue. Check the selected
document in the runner tab or the job's submission record, especially after a one-click
Quick Apply.

## Why didn't Handshook apply automatically?

Check the active mode on Home. **Dry run** only inspects jobs and never submits.
**Review** (an opt-out) fills each application and leaves the submit click to you; use
its **Open job** button to finish on Handshake. **Review before submitting** is also off
by default and only adds a review step when you turn it on.

On the default path, a specific job waits for you for one of two reasons: a **required
question has no saved answer**, or a **required document has no entered ID**. Both appear
in **Needs you** with the exact question or document type; supply it and retry. Handshook
never invents an answer or picks a file you did not enter. The run itself can pause for
its own controls — daily cap, pacing or a session break, active hours, an expired session,
a page it cannot identify (`UI_CHANGED`), or an uncertain submission — and the dashboard
shows why.

You can leave all setup answer fields blank and press **Continue**. Later use
**Settings → Answer bank** or answer the actual question in **Needs you**. Saved answers
are used automatically; sensitive answers follow the sensitive-answer switch, which is on
by default. Turn that switch off, or mark an individual answer as not-automatic, if you
want to approve those answers yourself.

Some Handshake jobs have a one-click **Apply** or **Quick apply** button that sends the
application immediately, with no form. Autopilot clicks these when **Let Autopilot use
Handshake one-click Apply** is on (it is on by default) and the normal gates pass.
Review never clicks them.

One-click Apply sends the resume and documents set as default in your **Handshake
profile**. Handshook cannot choose or change those files. Set your preferred resume as
default on Handshake if you rely on it. Forms with document pickers use your Handshook
choices; a one-click job that needs an answer you have not saved waits for you. An
uncertain send stays in **Needs you** for verification; check the job page or My Jobs
before taking another action.

## How do I turn automation off?

Stop the run, open **Settings → Run mode and safety**, and choose **Review** (fill the
form and submit yourself) or **Dry run** (inspect only, submit nothing), then **Save**.
Each switch can be turned off independently: **Review before submitting**, **Let
Autopilot use Handshake one-click Apply**, the sensitive-answer, EEO and free-text
switches, and — in **Settings → AI** — **AI page assist** and AI matching. Changes take
effect on the next run. An update to 1.1.0 moves existing installs to the automated
defaults once; an explicit **Dry run** is left alone, and your later changes are kept.

## Why did the run stop at the daily cap or wait?

The default cap is 15 applications per local day for new installs; settings allow at most 100.
Pacing delays, session breaks, active hours, or repeated failures can also pause a run.
Check the dashboard message. Wait for the cap to reset naturally; clearing local
history also removes duplicate-protection records and is not a way to increase limits.

## Do I need AI or a paid account?

No AI key is needed to use Handshook. AI is on by default, but without your own OpenRouter
key it stays on your device: basic keyword matching runs locally with no network service.
It selects among the resumes you entered; it does not write answers or create resumes.

- **Basic matching:** nothing to configure. Handshook scores the job title and
  description against your resume names and notes, and keeps the default resume if
  nothing fits confidently.
- **OpenRouter with your own key:** optional cloud matching uses your selected model.
  OpenRouter forwards the prompt to that model's provider. You manage the key,
  privacy choices, and any charges; Handshook does not supply a shared key.
- **AI page assist:** also needs your OpenRouter key. It only helps find a button or a
  document field the normal selectors missed.

Handshook no longer uses a built-in browser AI model, so there is nothing to download
or enable. Basic matching is the no-key default; see the
[changelog](../CHANGELOG.md) for what changed in this version.

## What is AI page assist, and what does it send?

Handshake occasionally renames or restyles a control. When Handshook cannot find
**Apply**, **Submit Application**, the resume card, or a cover letter/transcript/other
document field with its normal selectors, page assist asks your selected OpenRouter
model which control on the page to use.

It sends only a numbered list of at most 80 candidate controls, with their labels, roles,
input types, whether they are inside the application dialog, whether they are disabled,
and a few attribute names. Emails, phone numbers and long digit strings are masked before
sending; input values are never read. It does **not** send your saved answers, any form
value, document file contents, link targets, or page/job URLs. The model answers with a
number; Handshook checks it is on the list it sent, ignores a low-confidence answer, and
refuses destructive or unrelated controls (withdraw, delete, remove, cancel, upload,
close/back, sign out, save, share, preview, or anything that is not where that control
belongs — for example an Apply button inside the dialog). Every document, question, and
confirmation check still runs.

A model pick is remembered locally, so the same page markup needs no further AI call.
Turn page assist off in **Settings → AI**; without a key or permission it does not
run at all, and a control it cannot find follows the normal **Page changed** pause.

## How does Handshook answer application questions?

Your **answer bank** comes first — the answers you entered in setup, in **Settings →
Answers**, or once in **Needs you**. AI fills gaps only where no personal fact is involved.

1. A question whose wording matches a saved answer (or one of its alternate phrasings)
   is filled with your saved value.
2. A question worded differently — "What is your overall grade point average?" against
   your saved **Cumulative GPA** — is passed to AI answer assist, if you have an
   OpenRouter key. The model sees the question and the **labels** of your saved answers,
   never their values, and only says which saved answer applies. Handshook fills your
   saved value, checks it fits the question's choices (a GPA of 3.8 picks a "3.5 – 4.0"
   option), and remembers the match for next time.
3. If no saved answer covers it and the question does not depend on a personal fact —
   "How did you hear about this position?", "Why are you interested in this role?" — AI
   writes an answer from the job posting and your non-sensitive saved answers. Every AI
   answer is listed in **Activity**.
4. Anything else — your experience, eligibility, dates, history, demographics — waits in
   **Needs you** and is added to **Settings → Answers → Questions to answer**. Autopilot
   keeps applying to other jobs meanwhile. Answer it once and every job waiting on it goes
   back in the queue.

**Collect questions in advance.** Settings → Answers lists common screening questions
(major, degree, school, start date, relocation, on-site work, 18+, LinkedIn/portfolio)
alongside any question a run met. A **Dry run** also reads the questions of application
forms whose Apply button declares that it opens a form — without filling or submitting —
so you can answer them before an Autopilot run. A plain Apply button is never clicked in a
Dry run, because on Handshake it may submit immediately.

Answers you enter are used automatically. To confirm one for every job instead, open
**Settings → Answers** and turn its automatic switch off.

## What is OpenRouter?

[OpenRouter](https://openrouter.ai/) gives you access to models from multiple providers
with one account and API key. It replaces Handshook's former Gemini integration in
1.1.0. You can choose any available text-output model; model availability, structured
output support, and your routing/privacy settings determine whether a request works.
`deepseek/deepseek-v4.1-flash` is selected by default and can be changed.
Auto tries configured OpenRouter when a key, model, and permission are present, then
falls back to local keyword matching. A cloud error also falls back to keyword matching.

## How do I get and add an OpenRouter key?

1. Sign in to [OpenRouter's keys page](https://openrouter.ai/keys) and create a key.
   Review your account's privacy, spending limits, and billing settings.
2. In **Settings → AI**, choose OpenRouter, paste the key, and choose **Save key**.
   Allow the optional `https://openrouter.ai/*` permission when Chrome asks.
3. Choose **Load models**. `deepseek/deepseek-v4.1-flash` is already selected; keep it or
   choose another, then **Save** the AI settings. Optional fallback models can have
   different prices and data policies.
4. Choose **Test OpenRouter**. This makes a real, small request using fictional matching
   data and may cost money, even while AI matching is disabled. Enable AI when ready.

OpenRouter and its chosen provider receive the job title (up to 300 characters), job
description (up to 2,000), and each resume's document ID and the name you gave it as
text. These fields can contain personal information. Document files, saved answers, and
Handshake credentials are not sent in the prompt. The key is sent only to OpenRouter for
authentication and stored locally, unencrypted, outside exports/logs and content
scripts. Read the [privacy policy](./PRIVACY.md#ai-matching-and-page-assist) before
enabling it.

## Does OpenRouter cost money?

Paid models charge for input and output tokens; OpenRouter bills your account.
Check both displayed prices and [OpenRouter pricing](https://openrouter.ai/pricing)
before selecting a model. Provider tests also consume usage. Fallback models bill
at their own prices, so a free primary with a paid fallback is not a free-only setup.
The optional prompt-price ceiling limits the input price per million tokens; it is
not a total-spend or output-price cap. Use OpenRouter account/key limits for budgets.
No AI or paid account is needed for local keyword matching.

## Which model should I pick?

Start with a low-cost text model that supports **structured outputs** (JSON schema).
Resume selection and page assist are small classification tasks; an expensive reasoning
model is usually unnecessary. Handshook preselects `deepseek/deepseek-v4.1-flash`;
another inexpensive structured-output option is shown below.

| Model                                                                         | Input / output price per million tokens | Why try it                              |
| ----------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| [GPT-4o mini](https://openrouter.ai/openai/gpt-4o-mini), `openai/gpt-4o-mini` | $0.15 / $0.60                           | An inexpensive structured-output option |

Prices and availability change; refresh the catalog and check the current model
page. These are suggestions; only the preselected model is a default, and none
guarantees a correct resume or control choice. Check the chosen document on jobs you
care about. Models without structured output support can be selected, but invalid JSON
or an unknown resume ID falls back to local matching.

## Are free models unlimited, and what are the data caveats?

No. `:free` variants are separate model IDs. OpenRouter's published limits checked
on **2026-10-27** are generally 20 requests/minute and 50 requests/day, rising to
1,000/day after at least $10 in all-time credit purchases. Your account/key limits
and provider capacity still apply; see the [current limits](https://openrouter.ai/docs/api/reference/limits).
Tests consume requests too. A free model can disappear or become unavailable.

Some free providers collect prompts/completions or use them for training. Handshook
defaults **Allow providers that may store or train on job text** to off
(`data_collection: 'deny'`), so those
providers are excluded. Do not enable it merely to clear an error without reading
the model/provider policy and considering the personal metadata sent. Disallowing
collection is distinct from zero retention; **Zero-data-retention providers only** can narrow
availability further. Read [provider policies](https://openrouter.ai/docs/guides/privacy/provider-logging)
and [ZDR guidance](https://openrouter.ai/docs/guides/features/zdr).

## My model disappeared or expired

Refresh the model list in **Settings → AI**, choose an available replacement, save,
and test again. Also check any fallback models. A removed or expired model ID is not
silently replaced with an arbitrary paid model. Local matching remains available
while you choose; the catalog cache can be up to 24 hours old without a refresh.

## “No provider matches your privacy settings”

Your selected model has no route satisfying the current data-collection/ZDR settings.
Choose another model that supports your privacy choices, or explicitly allow data
collection only after reviewing that provider's terms. Review the ZDR option too;
no-collection and zero-retention are different requirements. Handshook does not
automatically relax either choice. The current job uses local matching.

## “Out of credits”

Check your OpenRouter balance and the key's spending limit on OpenRouter. Add credits
only if you want paid usage, or keep local matching. A negative balance can even
block free models. Credit/in-flight limits can return 402; account or key budgets
can return 403. See [OpenRouter's limit explanations](https://openrouter.ai/docs/api/reference/limits).
Handshook cannot charge your card or raise your budget for you.

## My key or provider test failed

401 means the key is invalid, disabled, or revoked; replace it from OpenRouter's
keys page. 403 can indicate moderation, a guardrail, or an exhausted budget. 429
means a request quota or provider rate limit: wait before testing again. A timeout
or unavailable model is not a successful test. If permission was denied or revoked,
use **Save key**, **Test OpenRouter**, or **Load models** to request it again. Keyword matching remains
available. Never include the key in a screenshot or support report.

## How do I remove the key?

In **Settings → AI**, turn AI off and choose **Remove key**, then confirm. The key
is removed from local storage; it was never included in backups or diagnostics.
To revoke it everywhere, separately delete/revoke it on
[OpenRouter's keys page](https://openrouter.ai/keys). Removing the local key does
not delete earlier provider requests or revoke Chrome's optional host permission;
manage that permission in Chrome's extension settings.

## What happens to my old Gemini key after updating?

1.1.0 deletes the stored Gemini key and changes the saved cloud-provider setting to
OpenRouter. A one-time notice explains the change. Old backups still import, but
do not restore credentials. Add an OpenRouter key and grant the new host permission;
keep or change the preselected model to resume cloud matching. Local keyword matching
remains available.

## Report a bug safely

1. Stop the run. Note the Handshook version, browser/OS version, error code, mode,
   and the steps that led to the problem. Use fictional job/account details.
2. Open **Settings**, scroll to **Advanced**, and click **Open diagnostics**, then
   **Export shareable diagnostics**. **Activity → Export shareable diagnostics** is
   another route to the same kind of export. This downloads a local JSON file;
   it is not sent to the developer automatically.
3. In the 1.1.0 export, shareable diagnostics retain status codes, settings flags,
   counters, and selector keys. They omit event message text, searches/URLs/keywords,
   company/job/document names, answers, and credentials. This is separate from
   **Export private backup**, which contains your personal records.
4. Open the diagnostic file in a text editor **before sharing**, especially if you
   use an older release. Remove any personal names, contact/account/school details,
   search URLs, document/job names or identifiers, free text, answers, and credentials
   you find. If unsure, do not attach it; a written report is enough.
5. Click **Report a problem** in **Settings → Advanced** or on the diagnostics page. It
   opens a GitHub bug report with your Handshook version, browser, OS, run mode, and
   recent error codes already filled in; nothing is sent until you review it and click
   **Create** on GitHub (a free GitHub account is needed). Each new report is listed
   automatically in [Known issues](./KNOWN_ISSUES.md#reported-by-users). You can also use the
   [support link](./STORE.md#distribution-links), or contact the owner who shared the
   ZIP if you cannot access GitHub. A GitHub issue can become public. Review
   screenshots too; crop out your name, school, documents, and application contents.

**Never attach a full backup, application CSV, resume, transcript, HAR/network capture,
cookies, password, or API key.** Diagnostics **Clear** removes diagnostic events and
selector history; it does not reset your application history or revoke OpenRouter keys.

## Reset data or uninstall

First stop the run. If you want a private backup, use **Settings → Your data → Export
private backup** (called **Export backup** in older versions). Backups contain your
searches, saved answers, the document IDs and names you entered, and application
history; protect the file.

- **Reset:** choose **Reset local data**, type `reset` when prompted, and confirm.
  This clears the extension's local records, settings, onboarding, and saved OpenRouter
  key. It does not withdraw applications or delete documents from Handshake. If reset
  reports that another tab holds storage open, close other Handshook panels/pages and
  try again. A successful reset returns to **Handshook setup**, step 1 of 6. Do not
  treat an error as a completed reset.
- **Uninstall:** open `chrome://extensions` (or Edge/Brave's Extensions page), find
  Handshook, choose **Remove**, and confirm. Downloaded exports and the unpacked folder
  are separate files; remove those yourself if you no longer need them.

Removing local history also removes the extension's record of previous applications.
Check Handshake itself before applying again after a reset or reinstall.

## Is this official, and is account safety guaranteed?

Handshook is independent and is not affiliated with or endorsed by Handshake.
Automation, delays, and caps cannot guarantee account safety or job outcomes.
Follow the platform's terms, check the applications it submits, and stop on account
warnings.
