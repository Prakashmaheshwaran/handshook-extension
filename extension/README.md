# Handshook browser extension

Handshook helps you apply to jobs on Handshake using your existing browser session,
uploaded documents, and answers you choose to save. **Full automation is the default:**
click **Start** and Handshook finds jobs, opens each one, clicks Apply, fills Handshake's
application dialog with your documents and saved answers, clicks **Submit Application**,
and verifies the result. Review mode and Dry run are opt-outs in Settings, and each
automation switch can be turned off on its own.

## Quick start (5 minutes)

Have your Handshake login and uploaded resume ready; school sign-in or uploading files
may take longer.

1. Get **`handshook-<version>-chrome.zip`** from the owner or release Assets (not
   **Source code**), unzip it, and keep the extracted folder in a permanent location.
2. In desktop Chrome, enter **`chrome://extensions`**, turn on **Developer mode**,
   click **Load unpacked**, and select the folder that contains `manifest.json`.
3. Open Chrome's puzzle-piece **Extensions** menu, click the pin beside **Handshook**,
   then click the pinned Handshook icon (**Open Handshook**) to open its side panel.
4. Sign into Handshake in the same browser profile. In setup, **Check session**, then
   click the link to your Handshake documents page, open a document, copy its link
   (`https://app.joinhandshake.com/docs/12345678`) or ID, and paste it into
   Handshook as your default resume. Add a cover letter, transcript, or other
   document if jobs need one, and optionally up to five named extra resumes for
   automatic matching. Optionally save reusable answers. Give your saved search a
   name and paste its Handshake results-page URL. Leave the default **Autopilot**
   mode selected.
5. Click **Finish setup**, then **Start**. Handshook opens its runner tab and starts
   applying. Watch the first few applications in **Queue**: a submitted job moves to
   **Applied** after Handshake's confirmation, and anything it will not guess appears
   in **Needs**. Use **Home → Stop** when you have seen enough.

For every screen label and troubleshooting step, follow the full guide below.

**[Install and get started](./docs/INSTALL.md)** — no terminal, Python, or AI key needed.
[FAQ and troubleshooting](./docs/FAQ.md) · [Privacy policy](./docs/PRIVACY.md) ·
[Downloads, store, and support links](./docs/STORE.md#distribution-links)

**Release status:** 1.1.4 is the current unreleased build; final hardening and owner validation are in progress.
Chrome Web Store publication and the owner-run application smoke are still pending.
The repository is private and had no published releases when checked on 2026-10-27;
the install guide explains private ZIP sharing until public distribution is ready.
Handshook is independent and is not affiliated with or endorsed by Handshake.

## What you need

- Current desktop Chrome (minimum **120**), a Handshake account, and a normal signed-in browser session.
- Resumes, cover letters, and transcripts already uploaded to Handshake as needed.
  Handshook identifies them by the document ID or link you paste; it never uploads,
  lists, or reads the documents page for you.
- Edge/Brave desktop may load the MV3 package with side-panel support, but are not
  validated release targets yet. No Firefox, Safari, or mobile support.

## How it works

1. Install from the store when available, or unzip the owner's release and **Load unpacked**.
2. Open the toolbar side panel, check your session, paste the links or IDs of the
   documents to use, save a job search, and leave the default **Autopilot** mode on.
3. Click **Start**. Handshook works through the queue on its own: it clicks **Apply**,
   fills Handshake's application dialog (your resume card, cover letter, transcript or
   other document, and saved answers), clicks **Submit Application**, and waits for the
   site's confirmation before marking the job applied.
4. Use **Needs you** for the few things it will not guess, and **Pause** or **Stop** on
   the dashboard at any time.

The run stops at a job only when a **required question has no saved answer** or a
**required document has no entered ID**; both go to Needs You with the exact question
or document type. Caps, pacing, login expiry, page changes and uncertain
submissions pause the run itself, exactly as before.

**Dry run** inspects and classifies jobs without clicking, filling, or submitting.
**Autopilot** (the default) submits eligible Handshake applications. **Review** is the
opt-out that fills each form and leaves the submit click to you. External employer
websites must still be completed manually.

To change anything, stop the current run, open **Settings → Run mode and safety**, adjust
the mode or the individual switches, and click **Save**. Then return to **Home** and
start. Turning off **Review before submitting** is no longer required for automation: it
is off by default, and switching it on is how you ask for a review step. Existing
installs are moved to these defaults once on update; a saved **Dry run** stays Dry run,
and a saved **Review** becomes Autopilot. Later changes are preserved.

Runs can start and continue at any hour. Updating or importing an older backup clears
its saved active-hours window. An existing active-hours pause offers **Resume** immediately.

Default daily cap: **15**, maximum setting: **100**. Delays, breaks, and
failure pauses limit runs. A submission already sent cannot be undone with Stop.
These controls cannot guarantee account safety or application accuracy.

## Your data and AI

Settings, saved answers, the document IDs and names you enter, and application history
are stored locally. Handshake receives form data through normal page interactions and
submissions. There is no Handshook backend, advertising, or telemetry. The extension
does not read Handshake passwords/cookies or document file contents.

AI is on by default. With no OpenRouter key it stays entirely local: keyword matching
chooses among your resumes on this device. Adding your own OpenRouter key switches on
cloud matching with **`deepseek/deepseek-v4.1-flash`** preselected (you can pick another
model) and **AI page assist**.

Matching sends the job title and description plus the document IDs and names of your
default and additional resumes to OpenRouter, which forwards the prompt to the chosen
model's provider. Page assist does something different and narrower: when Handshook
cannot find Apply, Submit Application, or a document field with its normal selectors, it
sends a numbered list of the page's **control labels, roles, and a few attribute names**
so the model can say which one to use; emails, phone numbers, and long digit strings are
masked first. It never sends answers, form values, document contents, or URLs. Handshook
then applies its own safety rules — controls such as withdraw, delete, upload, or cancel
are vetoed, as is a control in the wrong place — and every existing pre-submit check
still runs. A pick is remembered locally (the three most recent per target), so the same
page shape needs no AI call next time.

Cloud requests require your optional host-permission grant; provider data collection is
denied by default. Costs are billed by OpenRouter to you, including any chosen fallback
models. Turn AI or page assist off in **Settings → AI** at any time. See the
[exact payload and privacy policy](./docs/PRIVACY.md#ai-matching-and-page-assist).

OpenRouter replaces Gemini in 1.1.0. The update deletes stored Gemini keys; add an
OpenRouter key and grant its permission if you want cloud matching and page assist.
Matching and page assist both fall back safely without a key: local matching still runs,
and page assist simply does not fire (the normal selector failure applies). See
[AI setup and troubleshooting](./docs/FAQ.md#what-is-openrouter).

Backups/CSV exports contain private data. Diagnostics also require your review before
sharing; built-in redaction is not a guarantee of anonymity. Use the
[safe bug-report instructions](./docs/FAQ.md#report-a-bug-safely).

## Known limitations

Reported problems and workarounds are tracked in [Known issues](./docs/KNOWN_ISSUES.md).
To report a new one, open a
[bug report](https://github.com/Prakashmaheshwaran/handshook-extension/issues/new?template=extension-bug.yml).

- Live capture covered search and job-detail pages; the plain **Apply** button and its
  application dialog were confirmed on the live site on 2026-10-28. Other modal variants,
  document pickers, My Jobs, and blocked/login states remain fixture-tested until the
  owner completes [live smoke](./docs/LIVE-SMOKE.md).
- AI page assist only runs when an OpenRouter key and permission are configured; without
  them a control Handshook cannot find still becomes an explicit `UI_CHANGED` pause.
- External ATS completion and document uploads are unsupported.
- Handshake page changes can cause `UI_CHANGED` pauses.
- Cloud AI can encounter quotas/provider errors.
- One account per browser profile; do not run the Python tool at the same time.
- Resetting/uninstalling removes local duplicate-protection history. Check Handshake
  itself before retrying uncertain applications.

## Development

Use Node.js 22.18+ and npm. From `extension/` in your own checkout:

```bash
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
npm run zip
npm run package
```

Load `.output/chrome-mv3` from the browser's Extensions page for development.
`npm run dev` runs WXT's development build. For mock E2E, install Playwright Chromium
and run `npm run test:e2e` headlessly. Never point automated tests at a real account.

The friend walkthrough runs with `npx playwright test tests/e2e/walkthrough.spec.ts`
after the build. It packages the current build, checks the ZIP's checksum, unzips it
to a temporary directory, and loads that copy into a fresh persistent Chromium profile.
It covers setup, an automated submission and a Review opt-out run, safe defaults, and FAQ
recovery flows.
Screenshots go to ignored `test-results/walkthrough/`. Playwright opens the real panel
document in a tab; native toolbar pinning and the OS folder chooser still need the
manual steps in [INSTALL.md](./docs/INSTALL.md).

`npm run package` validates an existing build and writes
`.output/handshook-<version>-chrome.zip` and its SHA-256 checksum. The
[tag release workflow](../.github/workflows/extension-release.yml) creates a draft on
`ext-v<version>`; owner publication/store submission remains separate.
See the [launch runbook](./docs/LAUNCH.md), [release procedure](./docs/RELEASE.md), and
[store checklist](./docs/STORE.md).

Store assets in [store/](./store/) are generated from fictional demo data with
`node scripts/generate-store-assets.ts` after building.

## Project documentation

- [Launch runbook](./docs/LAUNCH.md) — Chrome Web Store and public GitHub checklist.
- [Architecture](./ARCHITECTURE.md), [contracts](./docs/CONTRACTS.md), and
  [decisions](./docs/DECISIONS.md).
- [Task status](./TASKS.md), [implementation plan](./PLAN.md), and [agent rules](./AGENTS.md).
- [Testing](./docs/TESTING.md), [selectors](./docs/SELECTORS.md), and
  [live capture record](./docs/SPIKE.md).
- [Security model](./docs/SECURITY.md), [1.1.0 security review](./docs/SECURITY-REVIEW.md#110--2026-10-27-rv-b),
  and [changelog](./CHANGELOG.md).
- [Python migration](./MIGRATION.md) and [port notes](./docs/PORT-NOTES.md).
