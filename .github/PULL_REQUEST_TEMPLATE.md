## What changed

<!-- A short summary. Link the issue with "Fixes #123" when applicable. -->

## Why

<!-- The user problem, bug, or policy requirement this addresses. -->

## How it was tested

<!-- Commands run and results. Say explicitly what was NOT tested (live account, Windows, etc.). -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm run test:e2e` (for UI, content-script, selector, or apply-flow changes)
- [ ] Manual check in Chrome 120+ described below

## Checklist

- [ ] The change is focused; unrelated refactors are in a separate pull request.
- [ ] New or changed behavior has tests, including a regression test for a bug fix.
- [ ] No secrets, cookies, real account data, resumes, captures, or `.output/` files are included.
- [ ] Privacy impact reviewed: no new data leaves the device without a documented user action.
- [ ] If a permission or host permission changed, `extension/docs/STORE.md` and
      `extension/docs/PRIVACY.md` are updated and the change is called out above.
- [ ] If AI payloads or providers changed, the allow-listed fields, masking, and recipient
      disclosure are updated and called out above.
- [ ] Automation safety is intact: submission authorization, pause/stop, caps, and uncertain
      submission handling still hold.
- [ ] User-facing copy and screenshots are still accurate.
- [ ] The version and changelog were **not** edited (release owner handles releases).
