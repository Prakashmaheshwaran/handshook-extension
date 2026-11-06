# Apply-flow fixtures

Synthetic DOM for `src/handshake/applyFlow.ts` integration tests. No live capture,
no real names, emails, documents, or tokens.

- `quick-apply-review.html` — Quick Apply advertises (and opens) a review dialog
  with a resume picker. Used for P0-3/P0-4: the adapter fills documents and stops
  before the final submit in review mode and when `reviewBeforeSubmit` is set.
- `quick-apply-single-click.html` — Quick Apply with no intermediate step. The
  click itself would submit, so review mode must report `manual_submit_required`
  without clicking.
- `handshake-form.html` — plain Apply opens a form dialog with a resume picker and
  a separate Submit Application button. Used for the dry-run and
  `reviewBeforeSubmit` gates.
