# Extension release procedure

For friends, use [Install Handshook](./INSTALL.md). This page is for the release owner
and integrator. The current build is **1.1.4, unreleased** until final
checks, owner smoke, and publication are complete. The repository is currently private.
See the [launch runbook](./LAUNCH.md) for the full Chrome Web Store and GitHub checklist.
[Distribution links and owner choices](./STORE.md#distribution-links) are maintained
in one place.

## Build and verify the final commit

Use Node.js 22.18+ and the committed extension lockfile. In a clean checkout, run
`npm ci` from `extension/`; never install into another worker's shared dependencies.

```bash
cd extension
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run test:integration
npm run build
npx playwright install chromium
npm run test:e2e
npm run zip
npm run package
```

The Playwright harness uses fixtures and a routed mock site, never the live account.
Keep it headless. CI installs Chromium's Linux dependencies and uses `xvfb-run` for
compatibility. Store artifacts come from `npm run package`; the WXT ZIP from
`npm run zip` is a separate intermediate artifact.

`npm run package` validates an existing `.output/chrome-mv3` build; it does not build.
It checks manifest/version/icons and rejects unexpected API permissions, development
files, and known secret patterns. Package checks are not a complete security review.
Recheck host permissions, AI payloads, and diagnostic exports against the final source.

Expected distributable files:

- `.output/handshook-<version>-chrome.zip`
- `.output/handshook-<version>-chrome.zip.sha256`

The ZIP has `manifest.json` at its root. Do not distribute GitHub's source-code archive
as an installable extension. No prior release hash or old test count proves a new build;
record the actual final source commit, commands/results, ZIP hash, and date.

## Tag-triggered draft release

The workflow [extension-release.yml](../../.github/workflows/extension-release.yml)
runs on **`ext-v*` tags**, such as `ext-v1.1.0`.

1. Finalize the version in package/lockfile, WXT config, and UI version source, and replace
   the Unreleased changelog placeholders with accepted changes. Do not tag 1.1.0 while
   package metadata, manifest, and UI disagree.
2. Complete the final checks and review the [store checklist](./STORE.md#release-checklist).
3. **OWNER ACTION:** authorize and push the matching tag at the reviewed commit.
   Tagging/pushing is a release action; it is not done by this documentation task.
4. GitHub Actions checks tag/package agreement, installs the locked dependencies, runs
   typecheck/lint/unit/integration, builds and runs `npm run zip`, tests that build
   with mock E2E, runs `npm run package`, verifies ZIP/checksum, and creates a
   **draft GitHub Release**.
5. Only the validated `handshook-<version>-chrome.zip` and its checksum are attached.
   Release notes include the exact commit, checksum, install guide, and changelog.
   The workflow uses only GitHub's automatic `GITHUB_TOKEN` (as `GH_TOKEN`) with
   `contents: write`; no custom secrets or store credentials are required.
6. A rerun may replace assets only while the release is a draft. It fails if the release
   is already published. For a published correction, prepare a new version/tag.

The workflow prepares artifacts; it does not prove a live smoke, publish the draft, or
submit to Chrome Web Store. Full formatting and the security review remain integrator
release gates alongside the automated workflow.

## Verify a downloaded package

Download the ZIP and matching checksum together. In the folder containing them, replace
`<version>` with the actual number:

```bash
# macOS
shasum -a 256 -c handshook-<version>-chrome.zip.sha256

# Linux
sha256sum -c handshook-<version>-chrome.zip.sha256
```

The output must say **OK**. On Windows PowerShell, run
`Get-FileHash .\handshook-<version>-chrome.zip -Algorithm SHA256` and compare the
Hash with the first value in the `.sha256` file. Do not load a mismatched package.
A matching checksum shows that the file matches the published checksum; obtain both
from the owner's trusted release channel.

For a locally built package, change into `extension/.output` first, because the
checksum file names the ZIP without a directory prefix. Use `unzip -t` for an archive
integrity check before loading it.

## Owner release acceptance

- [ ] Clean-profile install from the exact ZIP; onboarding, mock review, reload, and
      persistence verified. Check browser/version claims in the listing.
- [ ] [Owner live Review smoke](./LIVE-SMOKE.md) complete and recorded; no automated
      agent operates a real account or submits applications.
- [ ] Every [distribution URL](./STORE.md#distribution-links) works without repository
      credentials if advertising public distribution.
- [ ] Final UI screenshots and privacy/permission/data-use statements checked against
      the tagged build. No unresolved high-severity findings.
- [ ] Draft release notes include accepted changes, known limitations, source commit,
      exact checksum, and installation/support links.
- [ ] Owner publishes the approved draft and, separately, uploads the ZIP/assets to the
      Chrome Web Store dashboard after reviewing its forms.
- [ ] After store approval, update the single store URL in the distribution-links table.
- [ ] A small friend beta completes install/onboarding and reports sanitized issues.

Private ZIP sharing is available before public hosting, but the owner must still choose
the exact tested artifact and complete account smoke before recommending Autopilot.

## Upgrade and rollback

Unpacked users should stop, privately back up data, replace the contents of their
existing install folder, reload the extension, and refresh Handshake tabs. Keep only
one enabled Handshook install. A store install can have a different extension ID and
will not necessarily inherit the unpacked install's data.

Backup import restores supported records and resets unsafe automation options to safe
defaults; inspect the preview/warnings and start in Review. A malformed configuration
can fall back to defaults. Do not advise uninstalling just to update: that can remove
local application history.

If a release has a safety defect, tell testers to stop and disable it through the chosen
support channel, then ship a corrected version. Do not blindly restore old data and
resume uncertain submissions; check Handshake's own application history first.

## Known limits and integration notes

Live evidence at the baseline covers search/job-detail pages only. Application modals,
document pickers, My Jobs, and blocked/login states still need owner validation. Tests
on mocks do not close that gap. External ATS, document uploads, mobile, Firefox, and
Safari are unsupported.

The integrator must revisit the friend-facing mode/Stop/document wording after
HX-01–HX-04, AI payload/provider wording after HX-06, UI labels/screenshots after HX-08,
and diagnostics wording after HX-10. See the [HX-09 report](../../docs/hardening/HX-09.md)
for the source evidence and exact local gate results.
