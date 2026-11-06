# Security policy

## Supported versions

Security fixes are shipped in the latest `1.1.x` extension release. Older builds may
receive a fix only when the issue is severe and the upgrade path is unsafe.

| Version | Supported |
| ------- | --------- |
| 1.1.x   | Yes       |
| < 1.1   | No        |

The legacy Python CLI in the repository root is not a supported distribution target and
is documented separately in [CLAUDE.md](CLAUDE.md) and the [README](README.md). Report
issues that affect it through the same private channel so they can be triaged.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a suspected vulnerability.**

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (private advisory).
3. Include the affected version, browser and OS, a minimal reproduction, the impact, and
   any suggested fix.

If private reporting is unavailable, contact the maintainer through the
[repository owner's GitHub profile](https://github.com/Prakashmaheshwaran) and ask for a
private channel before sending details.

### What to include

- Extension version (from `chrome://extensions`), Chrome version, and operating system.
- The exact steps and the smallest fictional example that demonstrates the issue.
- Whether the issue requires a signed-in Handshake account, a specific permission grant,
  or a malicious page.
- The security property at risk: credential exposure, cross-site access, data leaving the
  device, permission bypass, remote code execution, submission without authorization,
  or integrity of the apply flow.

### What not to include

- Passwords, cookies, session tokens, API keys, resumes, transcripts, or application
  exports.
- Real student, school, employer, or job identifiers. Replace them with fictional values.
- Full private backups, HAR files, or captured pages containing account data.

If a secret was exposed, revoke or rotate it first. Deleting a public post is not enough;
GitHub history and forks may retain it.

## Scope

In scope:

- The MV3 extension source under `extension/` and its generated package.
- Manifest permissions, host permissions, and optional permission handling.
- Data boundaries: what is stored locally, what is sent to Handshake, and what is sent to
  OpenRouter or a model provider when AI is enabled.
- Submission authorization, pacing/cap enforcement, and the apply flow.
- Packaging: files included in the release ZIP, source maps, secrets, or development code.
- The release workflow and published checksums.

Out of scope:

- Vulnerabilities in Handshake, OpenRouter, the chosen model provider, Chrome itself, or
  another website. Report those to the affected vendor.
- Social engineering, physical access, or a compromised browser profile/device.
- The fact that automation may conflict with a third-party site's terms; that is a policy
  and account-risk concern documented in [the privacy policy](extension/docs/PRIVACY.md)
  and [store notes](extension/docs/STORE.md), not a software vulnerability.
- Missing hardening that does not cross a security boundary (for example, a missing
  `SameSite` attribute on a non-sensitive local setting).

## Response process

- Acknowledgement within **5 business days**.
- Initial triage and severity assessment within **10 business days**.
- A fix or mitigation plan for confirmed high-severity issues as soon as practical.
- Coordinated disclosure: we aim to publish an advisory after a fix is available and
  users have had a reasonable upgrade window, normally within **90 days**. We will agree
  a timeline with the reporter and credit them unless they ask to remain anonymous.

This is a small, maintainer-run project. These are targets, not contractual SLAs.

## Safe harbor

We will not pursue or support legal action against researchers who:

- test only against their own account, their own build, or a local copy of the extension;
- avoid privacy violations, data destruction, and service disruption;
- do not access, modify, or exfiltrate another person's data;
- report findings privately and give us a reasonable opportunity to fix them before
  public disclosure.

## Security-relevant documentation

- [Security model](extension/docs/SECURITY.md)
- [Security review](extension/docs/SECURITY-REVIEW.md)
- [Privacy policy](extension/docs/PRIVACY.md)
- [Architecture](extension/ARCHITECTURE.md)
- [Release procedure](extension/docs/RELEASE.md)
