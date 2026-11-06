# Security Review

## 1.1.0 — 2026-10-27 (OpenRouter provider change)

**Status:** documentation/security-contract update for OR-3; not an independent
post-switch source or generated-bundle certification. OR-1 owns the implementation
and integration must verify the final merged package. See [OR-3](../../docs/hardening/OR-3.md)
for checked sources, documentation gates, and remaining integration work.

- **New network boundary:** optional `https://openrouter.ai/*` replaces the Google
  API origin. The background sends chat POSTs to `/api/v1/chat/completions`, model
  GETs to `/api/v1/models?output_modalities=text`, and key-info GETs to `/api/v1/key`.
  No job/resume prompt is sent by the catalog or key-info lookups.
- **Permission re-check:** Save key / Test / Load models request the grant from a
  user gesture. Re-check immediately before every request, including after pacing
  and on retries. A prior grant or CORS success is not current user consent.
- **Key boundary:** store `openRouterApiKey` only in the isolated, unencrypted
  `chrome.storage.local` key store. Send it only to OpenRouter in the Bearer header;
  refuse redirects, omit cookies/referrers, and never add `HTTP-Referer`. Never return
  it to UI/content scripts or include it in logs, diagnostics, or backups; redact
  exact keys and `sk-or-` patterns before caching/broadcasting provider text.
- **Recipients and policy:** job title/truncated description and resume IDs/titles/
  descriptions go to OpenRouter and the provider serving the selected model, only
  when cloud matching is active. Tests use fictional input. No files, answer bank,
  Handshake credentials, or application history are in the prompt. Default
  `data_collection: 'deny'`; explicit collection opt-in and optional ZDR have
  different meanings. Free models can be incompatible with those privacy choices.
- **Migration and failures:** delete old Gemini keys, map legacy provider settings
  on load/import, supply defaults, and show the one-time migration notice. Check
  HTTP-200 error envelopes, validate JSON/resume allowlists, bound timeout/backoff,
  and retain heuristic fallback. Cache identity includes the responding model.
- **Required renewed evidence:** inspect the final manifest/bundles, test revoked
  permission on all three endpoints, content-script key isolation, reflected-key
  and export redaction, migration/import, and actionable privacy/credit/model errors.
  Costs, selected model fallbacks, and free-model data policies need owner review.

## 1.1.0 — 2026-10-27 (RV-B)

**Historical pre-OpenRouter snapshot:** this section records the original RV-B
review and its Gemini-specific evidence. Those provider paths, headers, and origin
are superseded by the contract above and are not current setup instructions.

**Scope:** release source, generated `.output/chrome-mv3/manifest.json` and every
JavaScript bundle, message/secret boundaries, data deletion and exports, privacy/store
claims, and production dependencies. Review used local fixtures and headless Chromium;
no live Handshake requests, Google requests, submissions, publication, or dependency
changes were made. Full evidence: [RV-B report](../../docs/hardening/RV-B.md).

**Result:** the findings below are fixed in this worktree. This is a bounded security
review, not store approval or a claim about untested real-tenant application forms.
RV-A owns the separate submit-pipeline review; FX-01 owns runner refresh behavior.

| Severity | Finding and resolution                                                                                                                                                                                                                                     | Evidence                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High     | Chrome exposes `storage.local` to content scripts by default, including the separately stored Gemini key. Restrict storage to `TRUSTED_CONTEXTS` before startup work and every key read/write.                                                             | `src/core/storage/settings.ts`, `src/background/router.ts`; real Chromium content-world read is denied in `tests/e2e/safety/release-security.spec.ts`. |
| Medium   | Saving a key after denying its host prompt could still allow CORS-enabled cloud requests; provider testing also omitted a new permission request. Check the current host grant before every attempt and request it directly from the test click.           | `src/ai/permissions.ts`, `src/ai/providers/gemini.ts`, `AiSection.tsx`; permission-denial/revocation and UI tests.                                     |
| Medium   | Gemini keys were embedded in request URLs and successful provider explanations were not scrubbed against the configured key. Use `x-goog-api-key`, refuse redirects, omit cookies/referrers, and redact reflected credentials before caching/broadcasting. | Gemini request and reflected-key regressions.                                                                                                          |
| Medium   | Handshake JSON fetches permitted redirects despite their documented same-origin boundary. Set `mode: same-origin` and `redirect: error`; keep GET and browser-supplied same-origin credentials.                                                            | `src/handshake/jobDetails.ts`; endpoint/method/options regression.                                                                                     |
| Medium   | Generated bundles contained Zod's dynamic `Function` probe and optional compiler even though application source did not. Select its existing interpreted parser at build time with a guarded transform; leave dependencies and default CSP unchanged.      | `scripts/mv3-zod.ts`, generated-bundle E2E assertion, full schema regression suite.                                                                    |
| Medium   | Chrome 116 did not match the engine's 30-second alarm floor, and the policy lacked an affirmative Limited Use statement/session-storage disclosure. Raise the manifest floor to 120 and reconcile the policies and store evidence.                         | Generated-manifest test; `PRIVACY.md`, `STORE.md`, `SECURITY.md`; README/INSTALL/FAQ minimum-version update coordinated with RV-C.                     |
| Low      | The health-check ping was the one unparsed runtime message. Validate its exact schema; it still returns only a constant pong after the sender check.                                                                                                       | `tests/unit/security-boundaries.test.ts`.                                                                                                              |

**Additional Medium disclosure fix (RV-C referral):** the AI settings paragraph
incorrectly omitted resume IDs/titles and API-key authentication and implied answers
never leave the browser. It now names the matching/test payloads, excludes files and
answers from AI requests, and explains that filling forms shares answers/document
references with Handshake. `ui-functional.test.tsx` asserts these distinctions.

**Manifest and network:** MV3 1.1.0; only `storage`, `alarms`, `sidePanel`, the four
US/UK Handshake patterns, and optional Google host. No broad host, external connector,
web-accessible resources, or CSP relaxation. All executable code/assets are packaged;
Handshake JSON uses only GET `/stu/jobs/{id}` or `/jobs/{id}`. Optional Google requests
use POST `/v1beta/models/{allowlisted-model}:generateContent`. Application writes happen
through the site's controls under the separate submit gates. Bundled React DOM contains
its generic HTML-rendering implementation, but application source never calls its unsafe
HTML prop; no page content is assigned to HTML sinks. The Vite module-preload fallback
fetches only packaged extension chunks, not a remote asset.

**Message and data checks:** all three runtime listeners validate sender identity and
schemas; no `onMessageExternal`/`onConnect` path exists. HX-05's version/run/job/attempt
checks and HX-10's export projections are retained. Keys never return in UI status,
content commands, events, diagnostics, or backups. IndexedDB remains local and unencrypted;
`storage.session` holds only temporary runner/pacing/restart state. Reset deletes the
database and key, resets settings/onboarding/pacing, and reports blocked deletion.
Chrome owns uninstall cleanup; downloaded files, an already open runner tab, optional
permission grants, and Chrome's downloaded model are not claimed to be deleted by reset.

**Dependencies:** `npm audit --omit=dev --json` reported **0 vulnerabilities** in the
production graph (6 packages counted by npm). No installs, fixes, or lockfile edits.

**Validation:** final gate counts are recorded in the RV-B report. Required gates are
typecheck, lint, formatting, the complete Vitest suite, production build, and headless
`tests/e2e/smoke.spec.ts` plus `tests/e2e/safety` (including generated-artifact and
real content-script storage tests). The historical review below is retained as an
older snapshot; its deferred message/host findings and blanket release verdict do
not describe the current release. Public policy hosting, final merged verification,
store certification, and owner-run live acceptance remain external release gates.

## Historical security review — 1.0.0

**Scope:** the production extension source at `extension/src`, the generated MV3 manifest,
storage, message boundaries, AI integration, packaging, and the store-facing behavior.
**Date:** 2026-10-25
**Reviewer:** release worktree review (T37 checklist in `docs/SECURITY.md` §11)
**Build reviewed:** 1.0.0, production `wxt build` output

### Verdict

**No high or critical findings.** Two low-severity hardening items were found and one was
fixed in this release; the other is recorded below with a decision. Two low/medium product
risks remain documented (local storage at rest, platform enforcement). The build is
cleared for store submission after the live smoke and final clean-profile install.

### Checks performed

| Check                                                                       | Result    | Evidence                                                                                                                                           |
| --------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `cookies` / `webRequest` / `<all_urls>` / `debugger` / `nativeMessaging` | Pass      | Built `manifest.json`; `docs/STORE.md` permission audit                                                                                            |
| No Handshake password field or password storage                             | Pass      | Source search; onboarding asks only for documents/answers/search                                                                                   |
| No `document.cookie`, `chrome.cookies`, `storage.sync`                      | Pass      | `grep -rn "document.cookie\|cookies\.\|storage.sync" src` → no matches                                                                             |
| No remote code, `eval`, `new Function`, or remote dynamic import            | Pass      | `grep -rn "eval(\|new Function\|innerHTML\|dangerouslySetInnerHTML"` → no matches; all dynamic imports are local screens                           |
| MV3 CSP intact                                                              | Pass      | Generated manifest has no loosened `content_security_policy`; no inline scripts in `sidepanel.html`; all JS is bundled from `'self'`               |
| No telemetry, analytics, ads, or project server                             | Pass      | Only outbound call is the optional Gemini endpoint; `grep -rn "fetch("` shows one provider call plus same-origin Handshake job-detail fetch        |
| No `console.*` in shipped source                                            | Pass      | `grep -rn "console\." src` → no matches; structured logger only                                                                                    |
| Page/job content rendered as text                                           | Pass      | React text rendering; no `innerHTML`/`dangerouslySetInnerHTML`/`document.write`/`insertAdjacentHTML`                                               |
| Outbound links safe                                                         | Pass      | `ExternalLink` sets `target="_blank"` with `rel="noreferrer noopener"`                                                                             |
| Handshake URLs allowlisted                                                  | Pass      | `src/handshake/host.ts` requires HTTPS plus `joinhandshake.com` / `joinhandshake.co.uk`; job IDs validated as positive safe integers               |
| AI output allowlisted                                                       | Pass      | `src/ai/validate.ts` requires strict JSON, exact keys, confidence 0–1, and a resume ID from the current list                                       |
| Prompt injection hardened                                                   | Pass      | Untrusted job text delimited with sentinels that are stripped from the text, 2,000/600-character caps, strict JSON-only instruction                |
| API key handling                                                            | Pass      | Stored only in `chrome.storage.local` (`handshook.ai.keys.v1`), never in settings, events, diagnostics, or logs; error text is key-redacted        |
| Log/diagnostic redaction                                                    | Pass      | `src/core/logging/redact.ts` redacts API keys, bearer tokens, JWTs, emails, phones, and cookie/session/token assignments before persistence        |
| Diagnostics contents                                                        | Pass      | Settings (`ai` object has no key), engine state, onboarding, redacted events, queue summary; no documents/answers payloads                         |
| Submission write-ahead / duplicate protection                               | Pass      | Existing submission ledger and restart reconciliation; unchanged in this release                                                                   |
| Optional Gemini host requested at runtime                                   | **Fixed** | `src/ui/screens/Settings/AiSection.tsx` now calls `browser.permissions.request` on save/test; previously the host was declared but never requested |
| Version metadata                                                            | **Fixed** | Mock/preview version fallback now reports `1.0.0`                                                                                                  |
| Dependency audit                                                            | Pass      | `npm audit --audit-level=high` and `--omit=dev` → 0 vulnerabilities                                                                                |
| Package safety                                                              | Pass      | `scripts/package.ts` rejects source maps, `.ts`/`.tsx`, tests, docs, dotenv, credential files, symlinks, and embedded private keys/Google API keys |
| Fixtures sanitized                                                          | Pass      | Employers, people, documents, and IDs are fictional; no real names, emails, cookies, or resume content                                             |
| Web-accessible resources / externally connectable                           | Pass      | Neither is declared; no page can message the extension                                                                                             |

### Findings and decisions

| #   | Severity         | Finding                                                                                                                                                                                                                                                                 | Decision                                                                                                                                                                                                                                                                                                |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium (fixed)   | The optional Gemini host permission was declared in the manifest but no code requested it, so BYOK Gemini requests would be blocked in a production install.                                                                                                            | Fixed: request the origin from the AI settings page inside the user gesture that saves a key or tests the Gemini provider; denial is surfaced as an error.                                                                                                                                              |
| 2   | Low (deferred)   | `browser.runtime.onMessage` guards messages by `type` prefix and `requestId` shape rather than parsing a full Zod request schema, and does not assert the sender origin.                                                                                                | Risk is limited: there is no `externally_connectable`, content scripts are extension-owned and isolated from page scripts, and unknown message types return `UNSUPPORTED_MESSAGE`. A full request schema requires changing the frozen contract and message router; schedule for the next minor release. |
| 3   | Low (deferred)   | `Settings.host` is validated as a non-empty string rather than against the Handshake allowlist. URL builders (`buildJobUrl`, `buildSearchUrl`, `sanitizeSearchUrl`) and content-page detection enforce the allowlist, and the host is not user-editable from the panel. | Add a `parseHandshakeHost` refinement to `settingsSchema.host` when the contract is next revised.                                                                                                                                                                                                       |
| 4   | Low (accepted)   | Local extension storage is not encrypted at rest.                                                                                                                                                                                                                       | Documented in `docs/PRIVACY.md`; rely on OS disk encryption. Optional passphrase encryption remains future work.                                                                                                                                                                                        |
| 5   | Medium (product) | Handshake UI changes can break selectors, and platform automation can carry account risk.                                                                                                                                                                               | Selector health, `UI_CHANGED` pauses, review-first default, conservative caps, and a live-smoke gate. Users remain responsible for platform terms.                                                                                                                                                      |

### Residual risks

| Risk                          | Severity   | Notes                                                                                                         |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| Handshake UI changes          | Medium     | Selector health plus `UI_CHANGED` pause; fixtures need periodic refresh.                                      |
| Handshake account enforcement | Medium     | Conservative caps, review-first default, no password or cookie handling.                                      |
| Store review / trademark      | Medium     | Own branding, no Handshake logo, explicit non-affiliation, ZIP fallback.                                      |
| Local storage not encrypted   | Low/Medium | Documented; OS disk encryption recommended.                                                                   |
| AI provider privacy           | Low        | Disabled by default; on-device preferred; BYOK requires the user's key and an explicit host-permission grant. |
| External ATS not automated    | Low        | Explicit handoff; no false success.                                                                           |

### Not covered by automated tests

- Live Handshake DOM and account behavior (use `docs/LIVE-SMOKE.md`).
- Chrome Web Store review behavior.
- Anti-bot enforcement (a product risk, not a test target).
- Browser-level permission prompt rendering (verified by code path and manual review only).

### Commands used

```bash
npm run typecheck
npm run lint
npx vitest run
npm run build
npm audit --audit-level=high
npm audit --omit=dev --audit-level=moderate
grep -rn "innerHTML\|dangerouslySetInnerHTML\|document.write\|insertAdjacentHTML\|eval(\|new Function" src
grep -rn "console\.\(log\|warn\|error\|debug\|info\)" src
grep -rn "document.cookie\|chrome.cookies\|browser.cookies\|storage.sync" src
grep -rn "fetch(" src
```

**Release rule:** do not submit an application without human review unless the autopilot
gate passes and the user explicitly enabled autopilot.
