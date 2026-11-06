# Live job-detail fixtures

## Source

- Captured: 2026-10-25
- Chrome: 155.0.8059.86 (macOS)
- Tenant: `app.joinhandshake.com`
- Pages:
  - `https://app.joinhandshake.com/jobs/{id}` (two external-apply postings)
  - the split-view detail pane at `/job-search/{id}` (one Handshake-apply posting),
    converted into a standalone page for selector tests

## What these fixtures prove

- The detail root is `[data-hook="job-details-page"]`.
- Title is the page `h1`, wrapped by an anchor to `/jobs/{id}`.
- Employer is the first non-empty `a[href^="/e/"]` (employer profile links use `/e/`,
  not `/companies/` or `/employers/`). The logo anchor has no text and must be skipped.
- Fields live in an "At a glance" block whose values are leaf `div`s with no per-field
  attributes. They are classified by value shape:
  - salary: currency/rate (`$25–30/hr`)
  - location: `Remote` / `Onsite, based in …` / `City, ST`
  - employment type: `Internship`, `Full-time`, …
- The description follows the `Job description` `h3` as the next sibling of the
  heading wrapper. There is no description `data-testid` or class hint.
- `Apply externally` renders as a `button[aria-label="Apply externally"]`.
- A Handshake-apply posting renders `button[aria-label="Apply"]` with visible text
  `Apply`. A "Quick Apply" label was not observed.

## Sanitization

- Employer names replaced with `Employer A/B`; job IDs replaced with `90000001`/`90000002`.
- Removed the account menu, student sidebar, "What your school says", collections,
  similar jobs beyond a placeholder, alumni names/profiles, and all scripts/styles.
- No personal names, emails, cookies, tokens, or resume content are present.

## Known gaps

- The application modal was never opened (read-only capture rule), so modal and
  screening-question selectors are not verified here.
- A quick-apply-specific label was not observed. The API's `job_apply_setting` is the
  authoritative discriminator between quick apply and the standard form.
- Applied, closed, not-open, login and challenge detail states were not observed.
