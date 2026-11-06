# Contributing to Handshook

Thanks for helping improve Handshook. This repository contains two things:

- **`extension/`** — the supported MV3 browser extension (TypeScript, React, WXT). Most
  contributions should go here.
- The repository root — the legacy Python CLI. It is documented for reference and is not
  the current distribution target. Do not add new user-facing features to it without
  discussing the direction first.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search existing [issues](https://github.com/Prakashmaheshwaran/handshook-extension/issues) and
  pull requests.
- For a security issue, **stop** and follow [SECURITY.md](SECURITY.md). Never open a
  public issue for a vulnerability.
- For a large feature, permission change, AI payload change, or new host permission,
  open an issue first. These need a policy and privacy review before code review.
- Use fictional data in every example, fixture, screenshot, and log.

## Development setup

Requirements:

- Node.js **22.18+** (CI uses Node 22) and npm.
- Desktop Chrome **120+** for manual testing.
- No Handshake credentials are needed for the mock test suite.

```bash
cd extension
npm ci
npm run dev          # WXT dev build with hot reload
```

Load the development build from `extension/.output/chrome-mv3` with
`chrome://extensions` → **Developer mode** → **Load unpacked**. Keep only one Handshook
install enabled at a time; a store install and an unpacked install can have different
extension IDs and separate data.

## Checks before opening a pull request

Run these from `extension/`:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test          # unit + integration
npm run build
npm run zip
npm run package       # validates the build and writes the store ZIP + checksum
```

For UI, content-script, selector, or apply-flow changes, also run the mock end-to-end
suite:

```bash
npx playwright install chromium
npm run test:e2e
```

The live harness (`npm run live`) operates a real Handshake account. It is owner-only
and must not be wired into CI or used with another person's account. See
[docs/LIVE-SMOKE.md](extension/docs/LIVE-SMOKE.md) and
[docs/TESTING.md](extension/docs/TESTING.md).

## What reviewers look for

- **Scope:** one coherent change; unrelated refactors are separate pull requests.
- **Tests:** new behavior has a unit, integration, or mock E2E test. A bug fix includes a
  regression test where practical.
- **Privacy:** no new data leaves the device without an explicit, documented user action
  and a policy update. AI requests must keep the allow-listed payload shape and masking
  described in [docs/STORE.md](extension/docs/STORE.md) and
  [docs/PRIVACY.md](extension/docs/PRIVACY.md).
- **Permissions:** adding a manifest permission or host permission requires a written
  justification, a review of least privilege, and updates to the store and privacy docs.
  Prefer `optional_host_permissions` for anything not needed on first run.
- **Safety:** automation must keep submission authorization, pause/stop, caps, and the
  “uncertain submission” behavior intact. Never add a path that guesses a required
  answer or silently retries an ambiguous submit.
- **No secrets or personal data:** no cookies, `.env`, `secrets.json`, real captures,
  resumes, or account screenshots in code, tests, issues, or commits.

## Code conventions

- TypeScript strict mode; avoid `any` and non-null assertions unless justified.
- Keep modules focused; business logic belongs in `src/core/`, page interaction in
  `src/handshake/` and `src/content/`, and wiring in `src/background/`.
- Prettier and ESLint are authoritative. `npm run format` before committing.
- Log with the existing structured logger and redaction helpers; do not log keys,
  answers, URLs, or page content.
- Prefer explicit, readable code over clever abstractions.

## Commit and pull request conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(extension): add per-job pause
fix(extension): keep the daily cap after a reinstall
docs(extension): clarify document ID setup
test(extension): cover uncertain submit settlement
chore(extension): bump version to 1.2.0
```

- Branch from `master` and use a descriptive branch name.
- Keep the pull request description focused on **what changed, why, and how it was
  tested**. The pull request template has the checklist.
- Reference the issue with `Fixes #123` when applicable.
- Do not include generated build output, `.output/`, or store ZIPs in a commit.
- Do not bump the version or edit the changelog in a feature pull request; the release
  owner does that as part of the release procedure.

## Release and store changes

The release owner follows [docs/RELEASE.md](extension/docs/RELEASE.md) and the
[launch runbook](extension/docs/LAUNCH.md). Tags matching `ext-v<version>` build and
stage a **draft** GitHub Release. Only the owner publishes a release, submits to the
Chrome Web Store, or changes repository visibility.

If your change affects the listing, permissions, data handling, screenshots, or support
documentation, update the corresponding checklist in
[docs/STORE.md](extension/docs/STORE.md) in the same pull request.
