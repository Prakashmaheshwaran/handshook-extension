# Launch runbook — Chrome Web Store and GitHub

This is the operational checklist for taking Handshook from a private, unpacked build to a
public Chrome Web Store listing backed by a public GitHub repository. It consolidates the
policy work that was previously spread across [STORE.md](./STORE.md),
[PRIVACY.md](./PRIVACY.md), and [RELEASE.md](./RELEASE.md).

**Status:** preparation only. Nothing in this document publishes a release, changes
repository visibility, or submits to Google. Every item marked **OWNER ACTION** is a
decision or an authenticated action that only the repository owner can perform.

**Current build:** `1.1.4`. Historical evidence in STORE.md that names `1.1.0` describes
the build that was actually tested at the time and is intentionally left unchanged.

---

## Definition of done

The launch is complete when all of the following are true:

1. The exact release ZIP was built from a reviewed commit, checksummed, installed on a
   clean Chrome profile, and smoke-tested by the owner.
2. The GitHub repository is public (or public distribution pages replace it) and every
   URL in the listing resolves while signed out.
3. The privacy policy and support destinations are reachable without a GitHub account.
4. The Chrome Web Store listing, privacy practices, and permission justifications match
   the generated `manifest.json` of that ZIP.
5. Google has approved the item and the approved listing URL is recorded in
   [STORE.md](./STORE.md#distribution-links).
6. A tag-triggered draft GitHub Release exists for the same version and checksum.

---

## Phase 0 — choose the distribution model

Pick one before touching either dashboard. The choice determines which URLs are valid.

| Model                              | Repository | What is public                                                              | Trade-off                                                                    |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **A. Public source (recommended)** | Public     | Source, docs, releases, issues, privacy policy, install guide               | Full transparency; requires a license, security policy, and secret hygiene.  |
| **B. Private source**              | Private    | Only a separate public page for privacy/support/install and the release ZIP | Hides implementation; you must host and maintain a separate public site.     |
| **C. Private friend beta**         | Private    | Nothing public                                                              | Does not satisfy Chrome Web Store public-policy prerequisites; not a launch. |

The rest of this runbook assumes **Model A**, with notes where Model B differs. The
repository already contains an [MIT license](../../LICENSE), which is the minimum legal
clarity a public repository needs.

---

# Part A — Chrome Web Store

## A1. Developer account prerequisites

**OWNER ACTION.** Complete these before creating the listing; the dashboard blocks
submission without them.

- [ ] Register a Chrome Web Store developer account at
      <https://chrome.google.com/webstore/devconsole>.
- [ ] Pay the **one-time US$5 registration fee** (card required).
- [ ] Verify the account contact email.
- [ ] Enable **2-Step Verification** on the Google account. Google requires it for
      developer accounts and will block publishing without it.
- [ ] Complete the **trader / non-trader declaration** if you distribute in the EU
      (Digital Services Act). A hobby/free project is normally a non-trader, but answer
      the dashboard's questions accurately; the declaration is public on the listing.
- [ ] Decide the publisher name shown on the listing (personal name or a verified
      publisher). A verified publisher is optional but improves trust.
- [ ] Keep recovery codes and the 2SV device backed up. Losing account access can make
      the listing unmaintainable.

Do not share the developer account, password, or recovery codes with a contributor.

## A2. Build and verify the submission artifact

Run from `extension/` on the exact commit to be released:

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
npx playwright install chromium
npm run test:e2e
npm run zip
npm run package
```

Expected files:

- `.output/handshook-1.1.4-chrome.zip` — upload this to the store.
- `.output/handshook-1.1.4-chrome.zip.sha256` — publish and verify this.

Before upload:

- [ ] Confirm `manifest.json` inside the ZIP is at the root and reports `1.1.4`.
- [ ] Confirm `minimum_chrome_version` is `120`.
- [ ] Confirm permissions are exactly `storage`, `alarms`, `sidePanel`, the four Handshake
      host patterns, and optional `https://openrouter.ai/*`.
- [ ] Confirm there is no `cookies`, `history`, `tabs`, `scripting`, `downloads`, or
      `<all_urls>` permission.
- [ ] Confirm no `.map`, `.env`, `secrets.json`, `cookies.json`, test fixture, or source
      TypeScript file is in the ZIP. `npm run package` rejects these.
- [ ] Record the commit SHA and the SHA-256 in the release notes.

The store does **not** accept GitHub's “Source code” archive as an extension package.

## A3. Store listing fields

Use copy from [STORE.md](./STORE.md#product-and-listing-copy); the table below is the
exact set of dashboard fields and the current value or source.

| Field                | Required                           | Value / source                                                                     |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| Item name            | Yes                                | `Handshook` (max 75 characters)                                                    |
| Short description    | Yes                                | 132-character summary in [STORE.md](./STORE.md#short-description)                  |
| Detailed description | Yes                                | [STORE.md](./STORE.md#full-description), up to 16,000 characters                   |
| Category             | Yes                                | Productivity (or the closest available dashboard category)                         |
| Language             | Yes                                | English                                                                            |
| Store icon           | Yes                                | [`store/icon-128.png`](../store/icon-128.png), 128×128 PNG                         |
| Screenshots          | Yes (≥1)                           | Four 1280×800 PNGs in [`store/`](../store/): dashboard, queue, Needs you, settings |
| Small promo tile     | Optional                           | [`store/promo-440x280.png`](../store/promo-440x280.png)                            |
| Marquee promo tile   | Optional                           | [`store/marquee-1400x560.png`](../store/marquee-1400x560.png)                      |
| YouTube video        | Optional                           | Leave empty unless a reviewed demo exists                                          |
| Homepage URL         | Optional                           | Public `extension/README.md` or a landing page                                     |
| Support URL          | Recommended                        | Public issues page or support page                                                 |
| Privacy policy URL   | Required when user data is handled | [PRIVACY.md](./PRIVACY.md) hosted publicly                                         |

Rules for the copy:

- No “unlimited,” “ban-proof,” “guaranteed interviews,” “bypass limits,” or “official
  Handshake tool.”
- Always state that Handshook is independent and not affiliated with or endorsed by
  Handshake.
- Keep the automatic-by-default behavior, the opt-out switches, the daily cap, the
  document-ID requirement, external-ATS limitation, desktop-only support, and AI data
  sharing visible. Do not bury them behind “learn more.”
- Screenshots must show the real extension, fictional data, and no account identifiers.
  Do not add badges for platforms or features that are not validated.
- Recount the short description after any edit (Chrome limit: 132 characters).

**OWNER ACTION:** upload and approve the images. They were generated by
`node scripts/generate-store-assets.ts` against a production build with intercepted
network routes; see [STORE.md](./STORE.md#assets) for the inspection note.

## A4. Privacy practices tab

This tab is where most submissions fail. Every answer must match the built manifest and
the actual code path, not the intention.

### A4.1 Single purpose

Paste the single-purpose statement verbatim:

> Help the user apply to job applications on Handshake using their existing browser
> session, uploaded documents, and answers they choose to reuse.

Do not describe secondary purposes (analytics, advertising, general browsing) because the
extension has none.

### A4.2 Permission justifications

Use the table in [STORE.md](./STORE.md#permission-justifications). For each permission,
the dashboard wants a short, concrete, user-facing reason and often a code location. The
justifications are already written for:

| Permission                                   | One-line justification                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `storage`                                    | Saves settings, run state, and an optional user-supplied OpenRouter key locally.             |
| `alarms`                                     | Schedules pacing, session breaks, and resumable run checks while Chrome runs.                |
| `sidePanel`                                  | Shows the queue, review controls, and settings beside the Handshake page.                    |
| `https://*.joinhandshake.com/*` (and apex)   | Reads Handshake pages and operates supported application forms using the user's own session. |
| `https://*.joinhandshake.co.uk/*` (and apex) | The same function on UK Handshake hosts.                                                     |
| Optional `https://openrouter.ai/*`           | User-requested resume matching, page assist, model catalog, and key usage checks.            |

Recheck the generated manifest before pasting. WXT adds `sidePanel`; the dashboard must
show the same permission set or the review will flag a mismatch.

### A4.3 Data usage categories

Answer the checkboxes using the worksheet in
[STORE.md](./STORE.md#data-use-disclosure-worksheet). The accurate summary:

- **Personally identifiable information** — yes, processed locally (saved answers,
  document IDs/names) and included in Handshake forms; limited resume metadata can reach
  OpenRouter and the chosen model provider if cloud matching is enabled.
- **Authentication information** — yes, an optional OpenRouter API key is stored locally
  and sent only to OpenRouter. Handshake passwords, cookies, and tokens are not read,
  copied, exported, or stored by the extension.
- **Health / sensitive information** — yes, only if the user chooses to save EEO or
  disability answers. Those values are used in forms when authorized and are not included
  as saved answers in AI prompts.
- **Location** — user-entered preferences and job locations only; no geolocation API.
- **Website content** — Handshake pages are processed; limited job text and resume
  metadata go to OpenRouter when enabled; page-assist sends control labels, roles, and
  allow-listed attribute names, with emails/phones/long digit runs masked.
- **User activity** — local application status, attempts, events, and counters; no
  advertising analytics.
- **Web history** — no browsing-history API; job URLs are local application records.
- **Personal communications / financial / payment** — no collection. A user-requested
  OpenRouter key check displays usage/limit metadata.
- **Sale, advertising, creditworthiness** — no.
- **Sharing** — Handshake as part of the normal application flow; OpenRouter and the
  chosen provider only for user-requested AI; voluntary support uploads controlled by the
  user.
- **Remote code** — **No.** All executable code is bundled. AI output selects only an
  allow-listed resume or a listed control index; it is data, not code.

Do not answer “no personal information” merely because there is no developer server.
Local processing and user-directed transfers still count.

### A4.4 Limited Use certification

Certify compliance with the Chrome Web Store User Data Policy, including the Limited Use
requirements. The privacy policy already states the boundaries:

- Data is used only for the extension's single purpose.
- No sale, advertising, creditworthiness, or unrelated use.
- No human reading of user data, except with explicit consent for support or as required
  by law.
- Transfers are limited to Handshake and the user-selected AI provider.

If you cannot certify an item honestly, change the code or the policy before submitting.

### A4.5 Privacy policy hosting

The policy at [PRIVACY.md](./PRIVACY.md) must have a **public URL that works without a
GitHub login**. Options:

1. **Public repository (Model A):** the GitHub blob URL works once the repository is
   public. Replace the placeholder row in
   [STORE.md](./STORE.md#distribution-links) with the exact URL.
2. **Private repository (Model B):** publish the policy to GitHub Pages or another static
   host. Do not link to a private blob.

Before submitting, open the URL in a signed-out private window and confirm it renders the
policy, the last-updated date, and a contact/support path. GitHub Pages is acceptable but
adds a deployment step; a blob URL is simpler and keeps a single source of truth.

A separate Terms of Use is **not required** by the Chrome Web Store or GitHub. If you add
one, link it from the listing and keep its acceptable-use and account-risk statements
consistent with [PRIVACY.md](./PRIVACY.md); do not contradict the Limited Use
certification.

## A5. Distribution settings

- **Visibility:** public. Unlisted is acceptable for a staged beta but it cannot be
  discovered and may not satisfy “public distribution” goals. Private is only for trusted
  testers and does not satisfy the policy prerequisites.
- **Regions:** all regions where you can support the product. The extension targets US and
  UK Handshake hosts; other regions can still install it but will have no matching site.
- **Pricing:** free. Do not add in-app purchases; there is no billing integration.
- **Mature content:** no.
- **Item updates:** automatic. There is no update server of your own; Chrome handles
  updates after store approval.

## A6. Submit and review

1. Upload the ZIP from A2.
2. Fill the listing, privacy practices, and distribution fields.
3. Use **Preview** and read every warning. Fix mismatches instead of explaining them away.
4. Submit for review. Review time varies from hours to several days; do not promise a
   date to testers.
5. Watch the developer account email. A rejection includes a policy citation; fix the
   specific issue, reply with evidence if the rejection is mistaken, and resubmit.
6. Do not upload a new version while a review is pending unless the dashboard offers to
   replace it.

After approval:

- [ ] Record the approved listing URL in [STORE.md](./STORE.md#distribution-links).
- [ ] Update the install guide to link to the store listing.
- [ ] Publish the matching GitHub Release (not a draft) with the same ZIP and checksum.
- [ ] Ask the 3–5 friend beta testers to install from the store listing and report
      sanitized issues.
- [ ] Keep the unpacked install instructions for development and rollback.

## A7. Review risks specific to this product

These are the areas most likely to draw reviewer questions. Address them in the listing
and the privacy policy; do not hide them.

| Risk                               | Why it matters                                                                                                                          | Mitigation already in place                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automation of a third-party site   | Handshook clicks Apply and submits forms on Handshake. Google reviews single purpose and user benefit, and users bear the site's terms. | Single-purpose statement, explicit user Start, pause/stop, caps, review/dry-run opt-outs, and a clear non-affiliation and terms notice.                                     |
| Broad host permission on Handshake | Reviewers scrutinize host access.                                                                                                       | Only Handshake US/UK hosts; no `<all_urls>`; no `cookies`/`tabs`/`history`; content script scoped to those hosts.                                                           |
| Optional AI provider               | Data leaves the device only after an explicit permission grant.                                                                         | Optional host permission, per-request grant check, fixed endpoints, redirect rejection, no cookies, key stored locally, payload documented field by field.                  |
| Saved sensitive answers            | EEO/disability data may be stored locally.                                                                                              | User-initiated only, local-only, excluded from AI prompts, disclosed in the privacy policy and data-use answers.                                                            |
| Remote code                        | Strictly prohibited in MV3.                                                                                                             | No remote code; bundled logic; AI returns data only; CSP unchanged.                                                                                                         |
| Misleading claims                  | “Autopilot” can sound like guaranteed outcomes.                                                                                         | Listing states limits: required questions pause, external ATS is manual, page changes can pause, no outcome guarantee.                                                      |
| Account risk                       | Handshake may treat automation as a terms violation.                                                                                    | The extension does not bypass authentication or rate limits; listing and docs tell users automation may be subject to Handshake's terms and to stop on any account warning. |

If Google rejects the item for automation or third-party terms, do not argue that the
policy does not apply. Narrow the described behavior, add the missing disclosure, and
resubmit; if the product cannot comply, keep it as an unpacked/private distribution.

---

# Part B — GitHub

## B1. Repository settings

**OWNER ACTION.** In **Settings**:

- [ ] Add a description: “Automated job application assistant for Handshake — Chrome MV3
      extension with local-only storage.”
- [ ] Add topics: `chrome-extension`, `manifest-v3`, `handshake`, `job-search`,
      `automation`, `typescript`, `react`, `wxt`, `privacy`.
- [ ] Upload a social preview image. GitHub recommends 1280×640; the store marquee is
      1400×560, so create a separate 1280×640 crop rather than stretching it.
- [ ] Confirm the default branch is `master`.
- [ ] Choose visibility. **Model A:** make the repository public only after the secret
      scan and history review below. **Model B:** keep private and host the public pages
      separately.
- [ ] Enable **Discussions** only if you intend to moderate them; otherwise leave it off
      and keep support in Issues.
- [ ] Set the repository website to the approved store listing or the install guide.

Before making the repository public, scan history, not just the current tree:

```bash
git log --all --full-history -- '*.env' '*.har' 'cookies*.json' 'secrets.json' 'conf.json'
git grep -I -n -E '(api[_-]?key|secret|password|token)\s*[:=]' $(git rev-list --all) -- \
  ':!*.md' ':!*.lock' ':!package-lock.json' | head -50
```

If a real secret is found in history, rotate it first. Removing the file in a later commit
does not remove it from clones or forks. If the history is otherwise clean, proceed;
otherwise use a fresh repository or a reviewed history rewrite.

## B2. Community and policy files

These are the files GitHub's community profile checks for, and the reason each exists:

| File                                                                                             | Purpose                                             | Status  |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------- |
| [`README.md`](../../README.md)                                                                   | Entry point, install, and project overview          | Present |
| [`LICENSE`](../../LICENSE)                                                                       | MIT license; required for a credible public repo    | Present |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md)                                                       | Setup, checks, commit/PR rules, privacy constraints | Present |
| [`CODE_OF_CONDUCT.md`](../../CODE_OF_CONDUCT.md)                                                 | Contributor Covenant 2.1 and enforcement            | Present |
| [`SECURITY.md`](../../SECURITY.md)                                                               | Private vulnerability reporting, scope, safe harbor | Present |
| [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)                     | Review and privacy checklist                        | Present |
| [`.github/ISSUE_TEMPLATE/extension-bug.yml`](../../.github/ISSUE_TEMPLATE/extension-bug.yml)     | Structured bug report with privacy warnings         | Present |
| [`.github/ISSUE_TEMPLATE/feature-request.yml`](../../.github/ISSUE_TEMPLATE/feature-request.yml) | Structured feature request with constraints         | Present |
| [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml)                   | Routes security reports and links docs              | Present |
| [`.github/dependabot.yml`](../../.github/dependabot.yml)                                         | Weekly npm and monthly Actions updates              | Present |
| [`.github/workflows/extension.yml`](../../.github/workflows/extension.yml)                       | Typecheck, lint, tests, build, package, mock E2E    | Present |
| [`.github/workflows/extension-release.yml`](../../.github/workflows/extension-release.yml)       | Tag-driven draft release with ZIP/checksum          | Present |

The community profile will still flag missing items it considers standard (for example a
`FUNDING.yml` or issue template for the legacy CLI). Those are optional; do not add files
just to turn the checklist green.

## B3. Branch protection and merge policy

**OWNER ACTION.** Protect `master` under **Settings → Branches**:

- [ ] Require a pull request before merging.
- [ ] Require at least 1 approval. For a solo maintainer, enable “Allow specified actors
      to bypass” for yourself rather than disabling review entirely.
- [ ] Require status checks to pass: `Extension CI` (typecheck, lint, format, test, build,
      package) and the mock E2E job.
- [ ] Require branches to be up to date before merging.
- [ ] Require conversation resolution.
- [ ] Dismiss stale approvals on new commits.
- [ ] Block force pushes and deletions.
- [ ] Do not allow direct pushes from automation.

Keep `master` releasable. Feature work belongs on a branch and lands through a pull
request; tags are created only from reviewed `master` commits.

## B4. Releases

The release workflow is tag-driven:

1. Finalize the version in `extension/package.json`, `package-lock.json`,
   `extension/wxt.config.ts`, and `extension/src/core/version.ts`.
2. Update `extension/CHANGELOG.md` and the current-version references in the docs.
3. Merge to `master`, then have the owner push the matching tag:

   ```bash
   git tag -a ext-v1.1.4 -m "Handshook 1.1.4"
   git push origin ext-v1.1.4
   ```

4. The workflow verifies the tag matches `package.json`, runs the gates, builds the ZIP,
   verifies the checksum, and creates a **draft** GitHub Release with only the ZIP and
   `.sha256` attached.
5. The owner reviews the draft, installs that exact ZIP on a clean profile, and publishes
   the release. The workflow never publishes on its own.
6. Upload the same ZIP to the Chrome Web Store. Do not rebuild between the two.

If the workflow fails, fix the cause on a branch and create a new tag; do not reuse a tag
that already has a published release. The workflow refuses to replace assets on a
published release.

Never publish a release whose ZIP does not match the uploaded checksum, and never
distribute “Source code” archives as installable extensions.

## B5. Security features

**OWNER ACTION.** Enable under **Settings → Code security and analysis**:

- [ ] Dependabot alerts.
- [ ] Dependabot security updates.
- [ ] Secret scanning and push protection (public repositories).
- [ ] Private vulnerability reporting (Security tab → Advisories).
- [ ] CodeQL / default code scanning if available for the repository. Expect noise from
      the legacy Python CLI; scope or dismiss findings deliberately.

Do not enable automatic fixing that rewrites dependencies without a pull request review;
the extension pins a lockfile and store packages must be reproducible.

## B6. Public URL verification

For Model A, open each URL in a signed-out private window:

- [ ] Repository root
- [ ] `extension/docs/INSTALL.md`
- [ ] `extension/docs/PRIVACY.md`
- [ ] `extension/docs/FAQ.md`
- [ ] Issues page (public, or a separate support destination)
- [ ] Releases page (with the published release visible)
- [ ] The privacy policy URL entered in the Chrome Web Store

For Model B, verify the equivalent public pages and replace every repository URL in
[STORE.md](./STORE.md#distribution-links), [INSTALL.md](./INSTALL.md), and the listing.

---

# Part C — Policy compliance matrix

| Requirement                                   | Where satisfied                         | Evidence to recheck before submission                                                 |
| --------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| Single purpose                                | Listing and privacy policy              | [STORE.md](./STORE.md#single-purpose), [PRIVACY.md](./PRIVACY.md#sharing-and-purpose) |
| Limited Use                                   | Privacy policy; dashboard certification | [PRIVACY.md](./PRIVACY.md#sharing-and-purpose)                                        |
| Minimum permissions                           | Manifest                                | Generated `manifest.json`; [permission table](./STORE.md#permission-justifications)   |
| No remote code                                | Bundled build, MV3 CSP                  | `scripts/mv3-zod.ts`, `npm run package`, generated bundle                             |
| No deceptive behavior or hidden functionality | Listing copy and UI                     | Screenshots, descriptions, actual run flow                                            |
| Minimum functionality                         | Working apply flow                      | Owner smoke test; mock E2E                                                            |
| Data transparency                             | Privacy policy and data-use answers     | Field-by-field payload notes in [STORE.md](./STORE.md#data-use-disclosure-worksheet)  |
| Secure transmission                           | HTTPS-only hosts and fixed AI endpoints | `wxt.config.ts`, `src/ai/providers/openrouter.ts`                                     |
| No sale/advertising/credit use                | Privacy policy; no such code            | Network call-site inventory in [STORE.md](./STORE.md#disclosure-evidence-for-110)     |
| Third-party terms and account risk            | Listing limitations and docs            | Non-affiliation notice; “automation may be subject to Handshake's terms”              |
| Developer account security                    | Google account                          | 2SV enabled and recovery codes stored                                                 |

This matrix is a preparation aid, not a legal opinion. Google, GitHub, and Handshake may
change their policies or interpret them differently. Re-read the current official policies
before submitting.

---

# Part D — Consolidated owner actions

- [ ] Choose Model A, B, or C and record the choice.
- [ ] Register/verify the Chrome Web Store developer account, pay the fee, enable 2SV,
      and complete the trader declaration.
- [ ] Approve the listing copy, screenshots, promo tiles, and claims.
- [ ] Approve the OpenRouter permission, both-recipient AI disclosure, routing defaults,
      usage costs, free-model caveats, and migration copy.
- [ ] Build the exact release ZIP, record the commit and SHA-256, and verify it on a clean
      Chrome profile.
- [ ] Complete the live Review smoke in [LIVE-SMOKE.md](./LIVE-SMOKE.md); stop on any
      account warning. Do not let an agent run live applications.
- [ ] Complete the store privacy-practices, permission, and data-use forms.
- [ ] Make the repository public (Model A) or publish the public pages (Model B), then
      verify every URL signed out.
- [ ] Enable branch protection, Dependabot, secret scanning, and private vulnerability
      reporting.
- [ ] Push the `ext-v1.1.4` tag, review the draft release, and publish it.
- [ ] Submit the store package and respond to review feedback.
- [ ] Record the approved store URL, update the install guide, and run the friend beta.
- [ ] After launch, keep the store listing, privacy policy, and docs in sync with each
      release; a stale permission or data-use answer is a policy violation, not just a
      documentation bug.

---

# Part E — Official references

Verify current requirements at the source; dashboard labels change.

- Chrome Web Store program policies: <https://developer.chrome.com/docs/webstore/program-policies>
- Publish in the Chrome Web Store: <https://developer.chrome.com/docs/webstore/publish>
- Prepare your extension: <https://developer.chrome.com/docs/webstore/prepare>
- Privacy practices and data use: <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- Permission warnings and justifications: <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>
- User Data Policy (Limited Use): <https://developer.chrome.com/docs/webstore/program-policies/limited-use>
- Remote code: <https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code>
- Manifest V3: <https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3>
- GitHub community health files: <https://docs.github.com/communities/setting-up-your-project-for-healthy-contributions>
- GitHub releases: <https://docs.github.com/repositories/releasing-projects-on-github>
- GitHub security advisories: <https://docs.github.com/code-security/security-advisories>
- Contributor Covenant: <https://www.contributor-covenant.org/version/2/1/code_of_conduct/>
