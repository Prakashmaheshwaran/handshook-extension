# Selector and DOM Strategy

Handshake is a React single-page app. Its DOM changes. The extension must be resilient, observable, and honest when it can't find something.

**Golden rule:** never submit an application when a required field, document, or question is uncertain. Pause and ask.

---

## 1. Principles

1. **Prefer accessible signals** — role, label text, `aria-label`, legend, button text. Avoid generated class names and `nth-child`.
2. **Centralize per feature** — each adapter owns `src/handshake/selectors/<feature>.ts`. Do not scatter selectors across logic.
3. **Strategy arrays, not single selectors** — each element lookup has 2–4 strategies ordered by reliability.
4. **Report health** — every strategy attempt records success/failure via `src/handshake/health.ts`.
5. **Wait for meaning** — wait for an element/state, not an arbitrary sleep. Human pacing sleeps are separate and intentional.
6. **Verify actions** — after clicking/selecting, confirm the expected state changed. A click that didn't change state is a failure.
7. **No destructive guessing** — required document, Submit, and sensitive answers are never guessed.
8. **Fixtures before final selectors** — use sanitized live DOM from `tests/fixtures/live/`; selectors that could not be observed live stay documented defensive fallbacks.

---

## 2. Page types and routing

| Page              | URL patterns (spike-confirmed)                                                                | Adapter                          |
| ----------------- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| Search            | `/job-search*` (saved search `/job-search/{id}?page=N` incl. split-view detail), `/postings*` | `discovery.ts` + `jobDetails.ts` |
| Job detail        | `/jobs/{id}`, `/stu/jobs/{id}`                                                                | `jobDetails.ts`                  |
| Application modal | `[role="dialog"]`, `[aria-modal="true"]`, portal                                              | `applyFlow.ts`                   |
| Documents         | `/docs` (opened for the user; never scraped)                                                  | none — user pastes links/IDs     |
| My Jobs           | my-jobs path (spike)                                                                          | `verification.ts`                |
| Login             | `/login`, `/signin`, SSO redirect                                                             | `lifecycle.ts`/session detection |

Verified against `app.joinhandshake.com` on 2026-10-25 (Chrome
155.0.8059.86). The application modal and documents pages were **not** opened
during that read-only capture; their selectors remain spike-pending.

The content script polls `location.href` every 500ms and dispatches a debounced route change. Do not rely on content-script re-injection for SPA navigation.

---

## 3. Discovery

**Goal:** extract job cards without clicking into them.

### Verified structure (2026-10-25, Chrome 155.0.8059.86)

- Result card: `[data-hook="job-result-card | {id}"]` — the ID is in the hook.
  This is more reliable than the link and works even for the selected card.
- Card overlay: `a[role="button"][aria-label]` with an empty text body. On the
  observed tenant its `href` is `/job-search/{id}` (not `/jobs/{id}`).
- Title: the first `div[aria-label]` inside the card. The card has no heading.
- Employer: the first non-empty `<span>` in the card.
- Footer: `[data-hook="job-result-card-footer"]`. Promoted cards prepend a
  `Promoted` span, so **classify** the location (`Remote` / `City, ST` /
  `Onsite…`) instead of taking a fixed child.
- Salary and employment type share one meta line, e.g.
  `$25-30/hr · Internship · Jun 1—Aug 1`; split on `·`.
- Pagination: `[data-hook="job-search-pagination"]`; icon buttons expose
  `aria-label` `first page`, `previous page`, `next page`, `last page` and use
  the native `disabled` attribute.
- Results announcement: `[data-hook="job-search-results-status-announcer"]`
  (e.g. `10K+ jobs found`); used as an empty-state signal only when it reports
  zero.
- There is no `data-job-id`; classes are styled-components hashes (`sc-*`).

Candidate signals (fallbacks for other tenants):

- Anchors with `href` matching `/jobs/(\d+)`, `/stu/jobs/(\d+)` or
  `/job-search/(\d+)`
- `data-job-id`, `data-testid*="job"`, `"jobId"` in embedded JSON
- Card container: nearest `article`, `li`, `[role="listitem"]`, or card-like ancestor
- Title: heading/link text
- Employer: adjacent text or `[data-testid*="employer"]`
- Location/type: card metadata text

**Rules:**

- Extract IDs from anchors, then derive the card from the anchor's ancestor.
- Do not extract IDs from unrelated links/sidebar/recommendations.
- Deduplicate by ID; if the same ID appears twice, keep the richest card.
- Ignore sponsored/promoted cards if they lack a normal job link.
- If a page yields zero jobs when the previous page yielded jobs, check for an empty-state message before flagging `UI_CHANGED`.

**Pagination:**

1. Button with accessible name matching `Next`, `Next page`, `›`, `→` that is not disabled.
2. URL with `page=N`/`paged=N` parameter; preserve other query params.
3. Stop: disabled/absent next, same first job ID twice, max pages, max jobs, explicit end text.

**Do not** scroll the entire page aggressively or open jobs to "warm up." It is unnecessary and bot-like.

---

## 4. Job detail

Extract:

- Title (`h1`; `[data-testid*="job-title"]` when present)
- Employer (`a[href^="/e/"]` on the live tenant — employer profiles are `/e/{id}`,
  not `/companies/`; skip the empty-text logo anchor)
- Description (content following the `Job description` heading; there is no
  description test id or class hint)
- Location, employment type, salary (the live "At a glance" block is a list of
  unlabelled values — classify by shape: currency, `Remote`/`Onsite…`/`City, ST`,
  employment keyword)
- Posted date (API `posted_at`; no `<time>` element was observed on detail pages)
- Apply button: `Apply` (`button[aria-label="Apply"]`) vs
  `Apply externally` (`button[aria-label="Apply externally"]`). A
  "Quick Apply" label was **not** observed; the API's `job_apply_setting` is the
  authoritative discriminator.
- Applied banner: not observed in this capture (no application was submitted).
- Closed/expired state: not observed.

### Verified structure (2026-10-25, Chrome 155.0.8059.86)

- Detail root: `[data-hook="job-details-page"]`.
- Title: `h1`, wrapped by an anchor to `/jobs/{id}`.
- Employer: first non-empty `a[href^="/e/"]` in the detail root.
- Sections are anchored by heading text (`At a glance`, `Job description`); the
  field containers themselves have only styled-components class names.
- External apply: `button[aria-label="Apply externally"]`.
- Handshake apply: `button[aria-label="Apply"]` with visible text `Apply`.

### Owner observation relayed 2026-10-27

The coordinator observed a Rosetta primary button with `aria-label="Quick apply"`,
`data-kind="button"` and `data-variant="primary"` inside the same detail root. A sticky
duplicate sits below an `opacity:0` ancestor. Match labels case-insensitively, prefer
the visible primary action, and ignore hidden/disabled copies. The application flow
and production inspection route wait up to 15 seconds for the root plus an actionable
control or a terminal posting status, using mutations and a polling fallback. A page
shell/title alone is not readiness evidence. Synthetic reconstructions are in
`tests/fixtures/ux-1`; no live Quick apply modal was observed. Existing Review,
document, authorization and positive-confirmation gates still apply.

API fallback:

- `GET /stu/jobs/{id}` with `Accept: application/json`, `X-Requested-With: XMLHttpRequest`, same-origin.
- `GET /jobs/{id}` if 422/404.
- 403 → DOM only.
- Never POST from this module.

---

## 5. Apply modal

Open:

- Click the Apply/Quick Apply button by accessible text. A plain **Apply** button with no
  `aria-haspopup` is not a one-click send: on the live site (owner screenshot,
  2026-10-28) it opens the application dialog below.
- Wait up to 10s for `[role="dialog"]`, `[aria-modal="true"]`, or a confirmation banner
  (Quick Apply may skip the modal). A plain Apply that opens the dialog must never be
  treated as an instant submit; only a proven one-click control may be.
- If no modal and no confirmation → `UI_CHANGED`.

Observed dialog structure (2026-10-28):

- Heading `Apply to <Employer>`, then `Details from <Employer>:` and
  `Applying requires a few documents. Attach them below…`
- **Attach your resume**: an already-selected card — check icon, file name (for example
  `something_resume.pdf`), a **Preview document** link, and an **×** remove button.
  "Preview" and "×" are not part of the selection flow: never click remove, and never
  treat preview as confirmation.
- **Attach your cover letter**: a search input with placeholder
  `Search your cover letters`, the word "or", and an **Upload new** button. **Upload
  new** is never clicked (no file uploads).
- Footer button **Submit Application**.

Owner-authorized read-only observation (2026-11-03): another application dialog
contains a visible paragraph, `Applying requires no additional documents.`, and
no attachment fields or cards. When posting metadata declares no document types,
this exact form skips the usual inferred resume requirement. Declared requirements,
visible attachment controls, unknown questions, Review mode and submit authorization
still gate submission. The declaration and absence of controls are checked again
after authorization. Synthetic coverage: `synthetic/apply/no-additional-documents.html`.

The same date's owner-authorized DOM inspection found an Other attachment field
headed **Attach other required documents**, with a **Search your other documents**
picker. The `required` qualifier must be recognised when locating its fieldset and
the selected card after the search picker closes. Matching also accepts `optional`
qualifiers. Document-ID verification still rejects a changed attachment. Synthetic
coverage: `synthetic/apply/other-required-document.html`.

Scope:

- Prefer the topmost visible dialog. Handshake may render a portal at `document.body`.
- Ignore hidden/background dialogs.
- Detect nested dialogs (e.g., document picker) and scope to the active one.

Submit:

- Button text `Submit Application`/`Submit`/`Apply`.
- Do not click a disabled button.
- Before click, verify: no unknown questions, required docs selected, no visible validation errors.
- After click, wait for positive confirmation.

### Page-assist fallback

Apply, Submit Application, the resume card, and the cover-letter/transcript/other
document fields each resolve through the deterministic strategies first. Only when a
required control is still missing does the apply flow call
`assistLocate(doc, target, { root, scope, control, signal })`:

1. The content script collects up to 80 visible candidate controls from the job page or
   the open dialog, with labels, roles, input type, dialog/disabled flags, and the
   allow-listed attributes from `src/core/contracts/pageAssist.ts`. It never reads an
   input value, and masks emails, phone numbers and 7+ digit runs before sending.
2. The background tries a learned signature for this host and target, then — if none
   matches — the OpenRouter model, and returns a candidate index or `null`. A confidence
   below 0.7 counts as no match.
3. The content script requires the pick to fit the target: Apply outside the dialog and
   button-like, Submit inside the dialog and button-like, a document field inside the
   dialog and picker/combobox/select/search-like. It rejects labels meaning withdraw,
   delete, remove, cancel, upload, close/back, sign out, save, share, preview, or similar.
   A rejected pick is treated as "not found".
4. The normal post-click and pre-submit verification for that target still runs. The
   background remembers the pick (three most recent per target and host), so the same
   page shape is tried from the learned signature first; the same rules are re-applied.

Page assist is a fallback, not a selector source: never add a model answer to
`selectors/*.ts`, never trust one without the vetoes, and never let it choose a document
or an answer.

---

## 6. Documents

### Documents page — RETIRED (no longer read)

Handshook does not scrape, list, paginate, or refresh the Handshake documents page.
There is no inventory, collection message, freshness timestamp, or page adapter;
the former `/docs` table selectors and pagination rules are removed. The user opens
that page themselves through the link to the Handshake documents page
(`handshakeLinks(settings.host).documents`) in a normal new tab, copies a document's
link (`https://app.joinhandshake.com/docs/12345678`) or bare ID, and pastes it into
setup or **Settings → Documents**. Handshook stores only the parsed ID and the name
the user types. Do not reintroduce page reads; any change here needs a product
decision, not a new selector.

### Application document fields

The resume slot may arrive already filled with a preselected card. Describe that card's
document ID from the markup when available; the picker strategies below are still used
when the markup does not expose it or the ID does not match. The cover-letter slot uses
the search input with placeholder `Search your cover letters`; never click **Upload new**.

Three strategies, in order:

1. **Search input / combobox**
   - Find by placeholder/label containing `resume`, `cover letter`, `transcript`.
   - Click to open; wait for listbox/options.
   - If the user gave the document a name, type it to narrow the list. With an
     empty name, open the picker and select without typing.
   - Match the option by document ID (`data-value`/`data-id`/`value`). A name is a
     search hint only, never the selection key.

2. **React combobox trigger**
   - Find `[role="combobox"]`, `[aria-haspopup="listbox"]`, `[aria-expanded]` near the field label.
   - Click; pick the `[role="option"]`, listbox `li`, or `li[data-value]` whose value
     is the document ID.

3. **Native/hidden `<select>`**
   - Find a `<select>` whose option values contain the document ID.
   - Use the native value setter + `change` event.

**Verify:** the hidden select value equals the ID, or the committed option's
`value`/`data-id`/`data-value` equals the ID. Visible trigger text alone is not
proof; a user-provided name may be displayed, and an unnamed document has no title
to compare. If the ID cannot be confirmed, report the failed strategies.

**Required vs optional:**

- Required missing → `MISSING_DOCUMENT`, no substitution.
- Optional missing → leave empty, log.
- Never pick the first option for a required document "just to proceed."
- Never match by title or name when the user left the name blank.

---

## 7. Screening questions

Scope to the application dialog. For each field:

1. Find control: `input`, `select`, `textarea`, `[role="combobox"]`, `[role="radio"]`, `[role="checkbox"]`.
2. Find its label:
   - `label[for=id]`
   - wrapping `<label>`
   - `aria-labelledby`
   - `aria-label`
   - nearest `fieldset > legend`
   - preceding sibling text
   - closest container text (last resort)
3. Required: `required`, `aria-required="true"`, asterisk in label, "required" text.
4. Options: native `<option>`, `[role="option"]`, radio/checkbox labels.
5. Current value: checked/selected/value.
6. Section: nearest fieldset/legend or heading.
7. Fingerprint: `sha256(normalizedLabel + type + optionLabels.join("|"))`.

**Ignore:** hidden, disabled, document selection comboboxes, search/filter inputs, buttons, and the submit area.

**Never:**

- infer a sensitive answer;
- fill a free-text question without an approved answer;
- treat a checkbox group as a single boolean unless the label clearly matches;
- submit with a required question empty.

---

## 8. Confirmation verification

Positive signals (at least one):

- Visible text `You applied on`
- `Application submitted` / `Application sent`
- Button changes to `Applied`
- Success toast/banner near the job title
- Job page no longer shows Apply/Quick Apply

Negative signals:

- Inline validation errors
- Modal remains open with required fields highlighted
- Error toast/banner
- HTTP 4xx/5xx from the application request (if observable)

**Ambiguous:** modal closed with no confirmation → `verifying`, not `applied`. Reconcile on next run by checking the job page/My Jobs. Never retry a possibly-submitted job without reconciliation.

---

## 9. React input handling

React controlled inputs ignore `element.value = x` unless the native setter is used and events are dispatched.

```ts
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
```

- For `contenteditable`, set `textContent` and dispatch `input` (test with fixtures).
- For checkboxes/radios, click the input or its label; verify `checked`.
- For `<select>`, use the native setter + `change`; for React-select/combobox, click + option.
- For date inputs, use the expected format; fall back to the picker only if tested.

**Do not** use `el.click()` on a disabled element or dispatch `submit` on the form directly; it bypasses app validation.

---

## 10. DOM utility API (T08)

| Helper                         | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `isVisible(el)`                | dimensions, visibility, display, opacity, viewport-independent |
| `waitFor(fn, timeout)`         | positive condition; abortable                                  |
| `waitForGone(fn, timeout)`     | disappearance                                                  |
| `findByText(root, matcher)`    | normalized text match over candidates                          |
| `findAllByText`                | all matches                                                    |
| `clickElement(el)`             | scroll into view + click + optional verify                     |
| `setNativeValue(el, value)`    | React-safe input                                               |
| `typeInto(el, text)`           | focus + native set + events                                    |
| `openCombobox(trigger)`        | click + wait for listbox                                       |
| `pickOption(root, matcher)`    | find/click option by ID/title                                  |
| `getAccessibleName(el)`        | aria/label/text fallback                                       |
| `closestFieldset(el)`          | question grouping                                              |
| `queryAllDeep(root, selector)` | shadow DOM/portal-safe query (if needed)                       |
| `matchesAny(text, patterns)`   | normalized keyword matching                                    |

All helpers must be abortable where they wait. Cancellation should reject with `CANCELLED`, not leave timers running.

---

## 11. Selector health

Every strategy group reports:

```ts
{ page, selector: "apply.button", strategy: "text:apply", ok: true }
```

- Consecutive failures per selector group are counted in `health.ts`.
- Threshold: 3 consecutive failures on the same page type → engine pauses with `UI_CHANGED`.
- Diagnostics shows the top failing selectors and the last successful strategy.
- A successful fallback resets the failure count but is logged as `selector.fallback`.

This is how we detect a Handshake redesign before it causes wrong applications.

---

## 12. Fixtures and live capture

- Sanitized live DOM lives in `tests/fixtures/live/<page>/`.
- Synthetic variants live in `tests/fixtures/<feature>/`.
- Each fixture folder has `README.md`: source page, date, tenant, sanitization notes, what it tests.
- Never commit raw captures with names, emails, cookies, CSRF tokens, or resume text.
- If a fixture is too large, extract the relevant subtree but preserve labels/roles/attributes.

### Live fixtures captured 2026-10-25 (Chrome 155.0.8059.86)

| Path                                            | Page                                    | Used by                                  |
| ----------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `tests/fixtures/live/discovery/job-search.html` | job search results + pagination         | `selectors/discovery.ts`, `discovery.ts` |
| `tests/fixtures/live/job/job-external.html`     | external-apply job detail               | `selectors/job.ts`, `jobDetails.ts`      |
| `tests/fixtures/live/job/job-handshake.html`    | Handshake-apply job detail (split view) | `selectors/job.ts`, `jobDetails.ts`      |

Each folder has `README.md` and `meta.json` with the capture date, Chrome
version, tenant and sanitization notes. The application modal, My Jobs, and
login/closed/applied states were not captured.

See [`SPIKE.md`](./SPIKE.md) for the capture procedure.

---

## 13. Anti-patterns (reject in review)

- `document.querySelector(".css-1x2y3z")`
- `nth-child` based selection for semantic elements
- `innerHTML` with job/page content
- Fixed `setTimeout` instead of `waitFor`
- Clicking Submit without verifying required fields
- Picking the first document when the required one is missing
- Hardcoded work-auth/sponsorship answers
- Treating a closed modal as success
- Clicking **Upload new**, **×** remove, **Preview document**, Withdraw, Delete, or Cancel
  as part of a selection or submit
- Trusting a page-assist pick without the destructive-control vetoes and normal verification
- Retrying a possibly-submitted job without reconciliation
- Reading cookies or injecting scripts into the page's main world to steal tokens
- Automating login/SSO
- Scrolling/clicking randomly to appear human

---

## 14. Tenant variants to test

- `app.joinhandshake.com` (default/global)
- a school subdomain (`*.joinhandshake.com`)
- `*.joinhandshake.co.uk`
- logged-out/login redirect
- different document picker option counts (0/1/3)
- Quick Apply vs Apply vs Apply Externally
- screening questions absent/present/custom free text
- job closed/not open/already applied
- slow network / late modal render
- modal rendered in a portal outside `#root`
