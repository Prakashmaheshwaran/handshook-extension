# Owner live smoke test

**Status: OWNER ACTION — not completed by HX-09.** Only the account owner performs
this on their own account. No CI or automated agent may drive the live site.
Mock E2E and search/job-detail captures do not prove a real application works.

## Before starting

- Install the exact build under test: the release ZIP via the [install guide](./INSTALL.md),
  or **Load unpacked** from a checkout's `extension/.output/chrome-mv3` after `npm run build`.
  Record its version and source commit (and the ZIP's SHA-256 for a release).
- Log into Handshake normally in the same browser profile; upload the documents you
  need there. Never export cookies or give an agent your credentials.
- Run only one copy of Handshook; stop the Python tool and other application automation.
- Pick jobs you actually intend to apply to, with documents and answers you can verify.
- Stay present. Stop on any account warning, CAPTCHA, rate limit, wrong document,
  unexpected submit, or unclear outcome.

## Pass 1 — setup and dry run

1. Complete onboarding; confirm the session and US/UK host.
2. Open the Handshake documents page from setup and paste the link or ID **and the file
   name** of the default resume, and of any cover letter, transcript or other document.
3. In **Settings → Answers**, fill **Questions to answer** (the common screening
   questions) and check your saved answers.
4. Save a small search and limit discovery to one page.
5. Select **Dry run**, start, and inspect the queue/fit reasons. Questions read from forms
   whose Apply opens a dialog appear in **Questions to answer**.
6. Stop. Confirm no application form was filled or submitted and nothing was sent.

## Pass 2 — one supervised Autopilot application (the default)

1. Choose **Autopilot** (the default). Note today's application count and set the daily
   cap to allow only **one more** confirmed application; ensure active hours include now.
2. Start and watch the runner tab. Check that the selected resume, cover letter and
   transcript match your documents and that every filled answer is correct. If anything
   is wrong, **Stop** before the submit.
3. Confirm a new site success indication for that exact job and an **Applied** queue
   status. Today's count should increase by exactly one.
4. Open **Activity**: any answer written by AI is listed there; check it.
5. If a job waited in **Needs you**, confirm the run moved on to the next job, then answer
   it and confirm it returned to the queue.
6. Stop. Reload the panel/extension and confirm history persists and the job cannot
   be automatically reapplied. If status is uncertain, check Handshake's own history
   before taking another action; never retry merely to see whether it worked.

## Pass 3 — optional Review opt-out check

1. Turn **Review before submitting** on in Settings → Run mode and safety.
2. Start; Handshook fills one application and stops before **Submit Application**.
   Check the form, then submit it yourself or stop without submitting.
3. Turn **Review before submitting** off again to return to the default. Record any pause
   or limitation.

Stop/ Pause is not an undo for a request already sent. Unknown results require manual
verification, never a second attempt for test coverage.

## Record the outcome

Keep personal details out of the repository and public issues.

| Evidence                                                                 | Result                          |
| ------------------------------------------------------------------------ | ------------------------------- |
| Date, extension version, source commit, ZIP SHA-256                      | Pending owner                   |
| Browser/version and OS; US/UK host family (no school/account identifier) | Pending owner                   |
| Dry run: no fill/submit                                                  | Not run                         |
| Autopilot: selected document types and answers correct                   | Not run                         |
| New confirmation, exact job, count +1                                    | Not run                         |
| Reload: history retained, no duplicate                                   | Not run                         |
| Optional Review opt-out: stops before submit                             | Not run / optional              |
| Warnings, UI changes, or unresolved result                               | Pending owner                   |
| Owner decision: proceed / hold                                           | Hold until required checks pass |

Use [reviewed diagnostics](./FAQ.md#report-a-bug-safely) and cropped screenshots only.
An account warning, wrong answer/document, duplicate, unexpected submit, unconfirmed
outcome, or repeated `UI_CHANGED` means **hold the release and investigate**.
