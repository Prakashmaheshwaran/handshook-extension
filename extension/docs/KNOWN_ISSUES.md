# Known issues

This file tracks problems that Handshook extension users have reported or that are already
known. Check it before reporting: your problem may already be listed with a workaround.

## Report a problem

1. Look for your problem in the table below and in
   [open issues](https://github.com/Prakashmaheshwaran/handshook-extension/issues).
2. If it is not there, open a
   [bug report](https://github.com/Prakashmaheshwaran/handshook-extension/issues/new?template=extension-bug.yml).
   If it is already reported, add a comment or a 👍 to the existing issue instead of opening a new one.
3. Follow the [safe bug-report instructions](./FAQ.md#report-a-bug-safely). Never post passwords,
   API keys, cookies, resumes, transcripts, private backups, or application CSVs. Issues are public.
4. For a security vulnerability, do not open an issue; follow the
   [security policy](https://github.com/Prakashmaheshwaran/handshook-extension/security/policy).

If an application or document looks wrong, stop the run first. Do not retry an uncertain
submission; check Handshake itself.

## Status values

| Status         | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| Open           | Reported and not yet fixed.                           |
| Investigating  | Being reproduced or diagnosed.                        |
| Fixed in x.y.z | Fixed; update to that version or later.               |
| Limitation     | Expected behavior that is not planned to change soon. |

## Tracked issues

| ID   | Summary                                                                                                                             | Versions | Status        | Workaround                                                                                                                                                    | Issue |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| KI-1 | A run pauses with `UI_CHANGED` after Handshake changes its pages.                                                                   | All      | Limitation    | Finish the job by hand from **Open job**; report the page if it keeps happening. AI page assist (OpenRouter key and permission) can find some moved controls. | —     |
| KI-2 | Jobs that apply on an external employer site (ATS) cannot be completed.                                                             | All      | Limitation    | Apply on the employer's site yourself.                                                                                                                        | —     |
| KI-3 | Document uploads are not supported; only documents already in Handshake can be chosen.                                              | All      | Limitation    | Upload the document to Handshake first, then rerun.                                                                                                           | —     |
| KI-4 | Cloud AI matching or page assist fails with a quota or provider error.                                                              | All      | Limitation    | Wait and retry, switch model or provider, or turn AI off to use local matching.                                                                               | —     |
| KI-5 | Modal variants, document pickers, My Jobs, and blocked/login states are covered by fixtures but not yet confirmed on the live site. | 1.1.4    | Investigating | Use Review before submit if a form looks unusual, and report what you saw.                                                                                    | —     |
| KI-6 | Resetting or uninstalling the extension removes local duplicate-protection history.                                                 | All      | Limitation    | Check your Handshake applications before retrying jobs.                                                                                                       | —     |
| KI-7 | Running two Handshake accounts in one browser profile, or running the Python tool at the same time, causes conflicts.               | All      | Limitation    | Use one account per browser profile and run one tool at a time.                                                                                               | —     |

## Reported by users

New bug reports are added here automatically when they are opened on GitHub, newest first.
Their status changes to Closed when the issue is closed. Maintainers move confirmed problems
into the table above.

<!-- reported-issues:start -->

_No reports yet._

<!-- reported-issues:end -->

## For maintainers

When a report comes in:

1. Label it `bug` and `needs-triage`, and reproduce it with the reporter's version.
2. If it is confirmed, add a row to the tracked-issues table with the next `KI-` ID, a link
   to the issue, and its status. The automatic entry under **Reported by users** stays.
3. When it is fixed, set the status to `Fixed in x.y.z`, note it in [CHANGELOG.md](../CHANGELOG.md),
   and close the issue. Remove `Fixed` rows two releases later.
