# Live discovery fixture — job search results

## Source

- Captured: 2026-10-25
- Chrome: 155.0.8059.86 (macOS)
- Tenant: `app.joinhandshake.com`
- Page: `https://app.joinhandshake.com/job-search` (redirects to a saved-search URL of the form `/job-search/{selectedJobId}?page=1&per_page=25`)

## What this fixture proves

- Result cards are `[data-hook="job-result-card | {id}"]` (25 cards on the live page).
- The whole-card overlay anchor is `a[role="button"][aria-label]` and its `href` is
  `/job-search/{id}` on this tenant — not `/jobs/{id}`. The anchor's text content is
  empty, so the accessible name is required as a title fallback.
- The visible title is the first `div[aria-label]` inside the card (the anchor is an
  `<a>`, the section wrapper uses `aria-labelledby`).
- The employer is the first non-empty `<span>` in the card.
- The footer is `[data-hook="job-result-card-footer"]`. Promoted cards prepend a
  `Promoted` span, so location must be classified (`Remote` / `City, ST` / `Onsite…`)
  rather than read from a fixed position.
- Salary and employment type share one meta line, e.g.
  `$25-30/hr · Internship · Jun 1—Aug 1`; the adapter splits on `·`.
- Pagination is `[data-hook="job-search-pagination"]` with icon buttons whose
  accessible names are `first page`, `previous page`, `next page`, `last page`.
  Disabled state is the native `disabled` attribute.
- A results announcement region exists at
  `[data-hook="job-search-results-status-announcer"]` ("3 jobs found" here).

## Sanitization

- Employer names replaced with `Employer A/B/C`.
- Job IDs replaced with `90000001`–`90000003`.
- Removed the account menu, sidebar, school/collection chips, alumni lists, filters
  beyond the search input, and all scripts/styles.
- No personal names, emails, cookies, tokens, or resume content are present.

## Known gaps

- Empty-state copy was not observed (every captured search had results).
- Applied badges were not observed on search cards.
- Styled-components class names are hashes and are intentionally omitted except where
  structure (not styling) matters.
