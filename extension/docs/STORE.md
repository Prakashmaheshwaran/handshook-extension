# Chrome Web Store listing and distribution

**Readiness: preparation, not a published release.** The current build is 1.1.4;
hardening and final asset review are in progress. Checkboxes below apply to the evidence
stated, not to an unbuilt merge of other workers. See the
[launch runbook](./LAUNCH.md), [release procedure](./RELEASE.md),
[privacy policy](./PRIVACY.md), and the [HX-09 report](../../docs/hardening/HX-09.md).

## Distribution links

**Single place to replace distribution URLs.** Installer, FAQ, and release docs link
here so the owner can update each destination once.

On 2026-11-06 the owner chose **private source, public distribution**: development stays
in the private `Prakashmaheshwaran/handshook` repository, and a cleaned public snapshot
(history-free, without `docs/audit/` and `docs/hardening/`) is published to
`Prakashmaheshwaran/handshook-extension`, default branch **master**. The private history
contained session cookies, so the private repository must not be made public.

| Destination      | URL                                                                                               | Current status                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Homepage         | <https://github.com/Prakashmaheshwaran/handshook-extension/blob/master/extension/README.md>       | Public; recheck signed out after each snapshot push.                                                                    |
| Install guide    | <https://github.com/Prakashmaheshwaran/handshook-extension/blob/master/extension/docs/INSTALL.md> | Public.                                                                                                                 |
| Privacy policy   | <https://github.com/Prakashmaheshwaran/handshook-extension/blob/master/extension/docs/PRIVACY.md> | Public, no login required.                                                                                              |
| Support          | <https://github.com/Prakashmaheshwaran/handshook-extension/issues>                                | Public issues.                                                                                                          |
| GitHub Releases  | <https://github.com/Prakashmaheshwaran/handshook-extension/releases>                              | OWNER ACTION: publish a reviewed release.                                                                               |
| Chrome Web Store | **PENDING — replace this cell with the approved listing URL**                                     | Item `koimmcoadjnkppajahgjfaecjgbgccei` (1.1.4) submitted for review 2026-11-06; publishes automatically once approved. |

The owner can choose:

1. **Public repository:** make the repository public after reviewing its contents,
   merge the extension docs onto `master`, and publish the approved release. The
   candidate URLs above can then be tested while signed out.
2. **Private source, public distribution:** publish only the homepage/install guide,
   privacy/support pages, and approved ZIP/checksum to a separate public repository
   or Pages site; replace the table URLs. Do not copy `docs/audit/`, `docs/hardening/`,
   private captures, or other internal material into that public site. Rewrite policy
   navigation links to the public support/changelog pages.
3. **Private friend beta:** send the exact ZIP and SHA-256 directly, or invite friends
   as repository collaborators, then use [Load unpacked](./INSTALL.md#option-b--release-zip-no-coding-needed).
   This does not satisfy the store's public privacy/support/homepage prerequisites.

No repository-visibility change, Pages deployment, release publication, or store
submission is performed by these docs. The tag workflow creates a **draft** release.

## Product and listing copy

- Name: **Handshook**
- Version: `1.1.4`; verify it against the final generated manifest before submission.
- Category: Productivity / Tools, using the available dashboard category.
- Language: English.
- Non-affiliation: independent; not affiliated with, endorsed by, or sponsored by Handshake.

### Short description

```text
Apply to Handshake jobs with your existing session, documents, and saved answers. Automation is on by default; you stay in control.
```

131 characters including spaces and the final period; limit 132. Recount after editing.

### Full description

```text
Handshook applies to jobs on Handshake using the account already signed into your
browser. Choose a saved search and paste the links or IDs of documents already uploaded
to Handshake, then work through applications from a side panel.

AUTOMATIC BY DEFAULT
Click Start and Handshook clicks Apply, fills Handshake's application dialog with your
resume card, cover letter, transcript or other document and your saved answers, clicks
Submit Application, and checks the site's confirmation before marking the job applied.
One-click Apply, saved answers, resume matching and AI page assist are on by default.
A required question with no saved answer, or a required document with no entered ID,
waits for you in Needs you with the exact item. External employer applications must be
completed manually.

YOU STAY IN CONTROL
Review and Dry run are opt-outs in Settings, and every switch can be turned off on its
own: review before submitting, one-click Apply, sensitive answers, EEO answers, free
text, AI matching and AI page assist. Pause or Stop is always available from the
dashboard. A submission already sent cannot be undone by stopping.

LIMITS YOU CONTROL
Default daily cap: 15 applications for new installs (existing caps are retained); maximum setting: 100. Pacing delays, session breaks, and failure pauses help you manage the run.

YOUR DATA
No Handshook account, backend, advertising, or telemetry. Settings, answers, document
IDs and names, and application history are stored locally. Filling/submitting applications
shares data with Handshake through its normal forms. AI is on by default but needs your
own OpenRouter key for any cloud request; without a key, matching stays on your device
and page assist does not run.
Cloud matching sends job text plus resume document IDs and the names you gave them to
OpenRouter, which forwards the prompt to the selected model's provider; names in
that metadata are included. AI page assist is narrower: it sends a numbered list of
control labels, roles and a few attribute names from the page so the model can pick a
button or document field, masks emails/phone numbers/long digit strings first, and never
sends your answers, form values, document contents or
URLs. Cloud requests require your optional permission grant.
Provider data collection is denied by default; some free models require opting in.
OpenRouter bills any usage to you, and optional fallback models have their own rates.
The key is stored locally, unencrypted, and sent only to OpenRouter for authentication.
Document files and the saved-answer bank are not sent to AI. A control pick is
remembered locally so later pages need no AI call.

LIMITATIONS
Documents must already be uploaded to Handshake; you tell Handshook which ones to use
by pasting their links or IDs. Handshook does not read or upload
resume files, complete external ATS forms, or store your Handshake password/cookies.
Desktop Chrome 120+ is required.
Handshake page changes may require an extension update or manual review. Without a key
AI page assist cannot run, and an unidentified control pauses instead of guessing.

Handshook is independent, not affiliated with or endorsed by Handshake. Automation may
be subject to Handshake's terms. No tool guarantees account safety, correct answers,
or job outcomes. Check what it submits and stop if the site shows an account warning.
```

Do not use “unlimited,” “ban-proof,” “guaranteed interviews,” “bypass limits,” or
“official Handshake tool.” Before uploading, the integrator must compare Autopilot,
document, answer, and Stop claims above to the merged HX-01–HX-08 behavior.

### Single purpose

> Help the user apply to job applications on Handshake using their existing browser
> session, uploaded documents, and answers they choose to reuse.

## Permission justifications

RV-B checked the generated production manifest before the OpenRouter switch. The
table below describes the 1.1.0 OpenRouter contract; integration must recheck the
final generated manifest, including removal of the former Google origin. WXT adds
`sidePanel` for the side-panel entrypoint.

| Manifest permission                                                   | Store justification                                                                                                                                                                                           | Source evidence                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                                             | Save settings, engine/onboarding state, and an optional user-supplied OpenRouter key in local browser storage.                                                                                                | `src/core/storage/settings.ts`                                                                                                                |
| `alarms`                                                              | Schedule pacing, session breaks, and engine continuation/verification while the browser runs. This does not bypass a user pause or run when Chrome is closed.                                                 | `src/core/orchestrator/engine.ts`, `src/background/router.ts`                                                                                 |
| `sidePanel`                                                           | Display the application queue, review controls, and settings beside the page; open them from the toolbar.                                                                                                     | `src/entrypoints/sidepanel/`, `src/background/router.ts`                                                                                      |
| `https://*.joinhandshake.com/*` and `https://joinhandshake.com/*`     | Read search and job pages and operate supported application forms on US Handshake hosts using the user's session.                                                                                             | `src/entrypoints/handshake.content.ts`, `src/handshake/`                                                                                      |
| `https://*.joinhandshake.co.uk/*` and `https://joinhandshake.co.uk/*` | The same function on UK Handshake hosts.                                                                                                                                                                      | Same as above.                                                                                                                                |
| Optional `https://openrouter.ai/*`                                    | User-chosen resume matching, AI page assist, tests, model catalog, and key usage/limits using the user's own OpenRouter key. Requested from Save key / Test / Load models and rechecked before every request. | `src/ai/permissions.ts`, `src/ai/providers/openrouter.ts`, `src/ai/models.ts`, `src/background/ai.ts`, `src/ui/screens/Settings/aiRuntime.ts` |

The wildcard host pattern also covers the apex; the explicit apex entries remain in
the current manifest and do not add unrelated sites. See Chrome's
[match-pattern reference](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns).
No `cookies`, `history`, `tabs`, `scripting`, `downloads`, or `<all_urls>` permission
is requested. No `web_accessible_resources` or `externally_connectable` entry is present.
No browser sync storage is used. Remote AI responses are data, not remotely executed code.
The default MV3 CSP is unchanged; `scripts/mv3-zod.ts` removes the dependency's optional
dynamic compiler during bundling and preserves Zod's interpreted validation.

Chrome **120** matches the engine's 30-second alarm floor. `sidePanel` and its toolbar
behavior are available before that floor; `storage.session` and `setAccessLevel` are
available from Chrome 102. There is no `AbortSignal.timeout` dependency (the code uses
`AbortController` plus bounded timers). See [Chrome's worker lifecycle history](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
and the [storage API](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Data-use disclosure worksheet

**OWNER ACTION:** enter and certify the current dashboard form after reviewing the final
build and [Chrome's privacy-field guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).
These are conservative disclosure facts, not a claim that data processed locally is
never collected or shared. Do not answer “no personal information” simply because there
is no developer server.

| Category / question                   | Accurate disclosure for the final form                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personally identifiable information   | Can be processed locally in saved answers and the document IDs/names you enter. Used in Handshake forms; resume names/IDs can also reach OpenRouter and the chosen model provider if cloud matching is enabled.                                                     |
| Authentication information            | Optional OpenRouter API key is stored locally, unencrypted, and sent only to OpenRouter for authentication. Handshake passwords/cookies/tokens are not read or exported by the extension; normal browser session credentials accompany site requests.               |
| Health / sensitive information        | Optional saved EEO/disability or other sensitive answers can be processed locally and used in forms when authorized. They are not included as saved answers in AI prompts.                                                                                          |
| Location                              | User-entered location preferences and job locations; no device geolocation API.                                                                                                                                                                                     |
| Website content                       | Handshake postings and application forms are processed. OpenRouter matching sends limited job text and resume metadata when enabled; AI page assist sends a numbered list of control labels, roles, and allow-listed attribute names (no values, answers, or URLs). |
| User activity                         | Local application status/history, attempts, events, and counters. No advertising analytics.                                                                                                                                                                         |
| Web history                           | No browsing-history API or tracking outside Handshake; saved searches and job URLs are local application records.                                                                                                                                                   |
| Personal communications               | No inbox/email/chat collection.                                                                                                                                                                                                                                     |
| Financial / payment information       | No payment details are collected. A user-requested OpenRouter key check displays usage, spending limits, and remaining allowance.                                                                                                                                   |
| Sale / advertising / creditworthiness | No sale, advertising use, or lending/creditworthiness use.                                                                                                                                                                                                          |
| Sharing                               | Handshake form interactions and optional OpenRouter/provider requests as described in the policy; voluntary support uploads are controlled by the user.                                                                                                             |
| Remote code                           | No. Executable code is bundled.                                                                                                                                                                                                                                     |
| Limited use                           | Use and transfer comply with the Chrome Web Store User Data Policy, including Limited Use requirements, as stated in the privacy policy. Owner certification and public policy hosting remain release actions.                                                      |

The exact OpenRouter matching payload in `src/ai/prompts.ts` is job title (300 characters),
job description (2,000), and each resume's ID and the name you gave it as text. The key
authenticates the request to OpenRouter; OpenRouter forwards the prompt to the selected provider.
A provider test sends fixed fictional matching data. There is no resume-file
upload or saved-answer-bank field in these AI requests.

AI page assist (`src/core/contracts/pageAssist.ts`) sends at most 80 candidate controls
with tag, role, input type, a short accessible name, up to 120 characters of visible
text/placeholder/nearest label, dialog/disabled flags, and only the attribute names
`aria-haspopup`, `aria-expanded`, `aria-label`, `data-hook`, `data-testid`, `data-kind`,
`data-variant`, `data-size`, and `name`. Emails, phone numbers and 7+ digit runs are
masked, and input values are never read. It sends no saved answers, form values, document
contents, `href`s, or page/job URLs. The model returns a candidate index, which is
validated against the submitted list; low-confidence answers, destructive or out-of-scope
controls, and controls in the wrong place are rejected before use, and every normal
document/question/confirmation check still runs. A model pick is stored locally (up to
three per target and host) and tried before any network call.

OpenRouter requests require a current
optional host grant, put the key in an authentication header, omit browser cookies,
and reject redirects. No `HTTP-Referer` or browsing-page URL is added as attribution
metadata. Catalog/key GETs send no
job/resume data. See `src/ai/permissions.ts`, `src/ai/models.ts`, and
`src/ai/providers/openrouter.ts`.

Default routing denies providers that collect data (`data_collection: 'deny'`).
Allowing collection is explicit opt-in; free models can require it and have daily
caps. Optional ZDR routing is separate and off by default. Disclose both OpenRouter
and the chosen model provider as recipients; no-collection routing is not a zero-
retention promise. OpenRouter bills usage to the user; fallback models may cost more.
The key is stored unencrypted in `chrome.storage.local`, never exported/logged or
sent to Handshake pages. Migration deletes old Gemini keys; users add an OpenRouter key
and keep or change the preselected model. See [PRIVACY.md](./PRIVACY.md#ai-matching-and-page-assist).

### Disclosure evidence for 1.1.0

Paths below are relative to `extension/`. These are the code sources for the worksheet,
including prior negative checks from RV-B. OpenRouter paths describe the new
contract/source and require final merged-build verification; RV-B is not evidence
that the new provider has passed a generated-bundle review.

| Disclosure                                                   | Code evidence                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal and sensitive answers                               | `src/core/storage/answers.ts`, `src/core/answers/policy.ts`, `src/handshake/questions.ts`; only authorized form filling uses saved answers.                                                                                                                                                                                                   |
| Document IDs/names and optional OpenRouter/provider transfer | `src/core/documents/selection.ts`, `src/ai/prompts.ts`, `src/core/orchestrator/engine.ts`; user-entered IDs and names only, no page reads, listing, or file reads/uploads.                                                                                                                                                                    |
| AI page assist payload and control vetoes                    | `src/core/contracts/pageAssist.ts` (targets, candidate/allow-listed attribute schema), `src/handshake/page-assist.ts` (locate + safety), `src/core/contracts/submitAuthorization.ts` (`ApplyControl.pageAssist`); no answers, values, document contents, or URLs.                                                                             |
| Authentication                                               | `src/core/storage/settings.ts` isolates `storage.local` before key access; `src/ai/providers/openrouter.ts` authenticates only the fixed OpenRouter endpoints; `src/handshake/jobDetails.ts` uses browser-supplied same-origin credentials.                                                                                                   |
| Location preferences and website content                     | `src/core/contracts/index.ts` settings schema, `src/handshake/discovery.ts`, `src/handshake/jobDetails.ts`, `src/handshake/questions.ts`; no geolocation API.                                                                                                                                                                                 |
| Activity/history and temporary session state                 | `src/core/storage/db.ts`, `src/core/storage/submissions.ts`, `src/core/orchestrator/session.ts`, `src/background/router.ts`; IndexedDB records and memory-only runner/pacing state.                                                                                                                                                           |
| No general history, inbox, or payment collection             | Generated manifest has only the permissions above; `src/entrypoints/handshake.content.ts` limits page access; discovery/job/form adapters contain no inbox/payment/history collectors. User-entered free text can still contain personal data.                                                                                                |
| Private exports and shareable diagnostics                    | `src/core/migration/export.ts`, `src/core/migration/serialize.ts`, `src/core/logging/redact.ts`, `src/core/diagnostics/{export,privacy}.ts`; private exports retain personal records but exclude credentials, while diagnostics use reviewed fields only.                                                                                     |
| Transfers, no ads/sale/analytics, single purpose             | Network call sites are `src/handshake/jobDetails.ts` (two same-origin GET paths) and `src/ai/providers/openrouter.ts` (opt-in OpenRouter chat POST and models/key GETs); `src/handshake/applyFlow.ts` operates normal page controls. No developer endpoint, telemetry, remote config, WebSocket, beacon, or remote asset load is implemented. |
| Remote code and Limited Use                                  | `wxt.config.ts`, `scripts/mv3-zod.ts`, `src/ai/validate.ts`, generated bundle inspection, and `docs/PRIVACY.md#sharing-and-purpose`; all logic is packaged and AI output selects only an allowlisted resume or a listed control index.                                                                                                        |

## Assets

Assets were regenerated and visually inspected for **1.1.0 on 2026-10-27** by
`node scripts/generate-store-assets.ts` after a production build. The generator
loads the actual extension in a temporary headless profile with fictional records;
network routes are intercepted/blocked and DNS is pinned to localhost. It does not
enable the development demo bridge or use an account screenshot.

| Asset               | File in [store/](../store/)                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| Dashboard, 1280×800 | `screenshot-dashboard-1280x800.png` — automated defaults, daily count, next action |
| Queue, 1280×800     | `screenshot-queue-1280x800.png` — current queued/needs controls                    |
| Needs you, 1280×800 | `screenshot-needs-1280x800.png` — recovery and answer entry                        |
| Settings, 1280×800  | `screenshot-settings-1280x800.png` — complete Run mode and safety section          |
| Promo, 440×280      | `promo-440x280.png`                                                                |
| Marquee, 1400×560   | `marquee-1400x560.png`                                                             |
| Store icon, 128×128 | `icon-128.png`                                                                     |

Production icons are `src/public/icon-{16,32,48,128}.png` and
`icon-action-{16,32,48}.png`, regenerated from the existing SVG artwork. PNG header
dimensions match the inventory; all seven store images were opened and inspected
for clipped text, repeated raster bands, demo badges and developer artifacts.
The marquee shows the whole panel; the Settings capture ends after the safety
section. Captions disclose automated defaults, the opt-out switches, and optional cloud AI
without claiming
platform-limit guarantees. **OWNER ACTION:** approve these images and upload them.

## Release checklist

Checked items are preparation/local evidence, not store approval.

- [x] Install guide, FAQ, listing copy, single purpose, and permission justifications written.
- [x] Privacy/data-use text updated for the OpenRouter contract and HX-10's
      diagnostics/private-export boundaries; final integration checks remain below.
- [x] RV-B production build inspected: version 1.1.0, minimum Chrome 120,
      `storage`, `alarms`, `sidePanel`, four Handshake hosts, and the former cloud
      origin. Historical evidence only; it predates OpenRouter.
- [x] 1.1.0 store assets regenerated, dimensions verified and visually inspected;
      owner listing approval remains below.
- [x] Tag-triggered draft-release workflow and safe bug-report template prepared.
- [x] 1.1.0 versions/changelog finalized and rebuilt after all HX branches merged.
- [x] Full merged typecheck, lint, formatting, unit/integration cases, headless mock
      E2E cases, packaging and privacy/message-boundary regressions pass; final counts,
      exact tested
      commit/results/checksum are in the integration report. This is automated evidence,
      not a new independent security sign-off.
- [x] Hardening waves integrated and privacy/AI/diagnostic flow reviewed; remaining
      limitations and owner acceptance gates are in the RC report.
- [ ] OWNER ACTION: choose hosting and verify every distribution URL while signed out.
- [x] INTEGRATION: rebuilt after OR-1/OR-2/OR-3 merge; verified optional
      `https://openrouter.ai/*` replaces the Google origin, permission revocation
      blocks chat/models/key requests, keys stay isolated/redacted, and migration
      deletes old keys. Full gates and the new ZIP/checksum are recorded in
      [INT-OR integration evidence](../../docs/hardening/INTEGRATION.md#openrouter-switch).
- [ ] OWNER ACTION: approve the OpenRouter permission and both-recipient data-use
      disclosure, routing defaults, usage costs, free-model caveats, and migration copy.
- [ ] OWNER ACTION: clean-profile install from the exact release ZIP and onboarding;
      validate any advertised Edge/Brave support.
- [ ] OWNER ACTION: complete [live Review smoke](./LIVE-SMOKE.md), record confirmation/count,
      and stop on any warning. No agent-run live applications.
- [ ] OWNER ACTION: inspect the draft release, checksum, screenshots, and listing claims.
- [ ] OWNER ACTION: developer account verification, public privacy/support/homepage fields,
      permission/data-use certification, and screenshot upload.
- [ ] OWNER ACTION: publish the GitHub release / submit the store package; insert approved
      store URL only after approval.
- [ ] OWNER ACTION: 3–5 friends complete installation/onboarding; gather sanitized feedback.

Keep external-ATS handoff, existing-document requirement, desktop-only support,
optional AI limitations, and potential UI-change pauses visible in the listing.

The **I added the document** same-URL runner refresh gap was resolved by FX-01 and
verified without the manual refresh workaround. Final build/gate/checksum evidence
and remaining owner gates are in [INTEGRATION.md](../../docs/hardening/INTEGRATION.md)
and [RC-1.md](../../docs/hardening/RC-1.md).
