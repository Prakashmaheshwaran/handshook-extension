# Job-detail fixtures (synthetic)

Hand-written, sanitized job pages for `src/handshake/jobDetails.ts`. No real
company, person, resume, or token content is included.

| File                  | Covers                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `quick-apply.html`    | Full DOM extraction (title, employer, description, location, type, salary), Quick Apply    |
| `handshake-form.html` | Company link employer, definition-list metadata, article description fallback, plain Apply |
| `external.html`       | Apply Externally link, offsite href                                                        |
| `applied.html`        | "You applied on" banner and Applied button                                                 |
| `closed.html`         | No-longer-accepting-applications copy                                                      |
| `not-open.html`       | Future application window copy                                                             |
| `login.html`          | Password field and sign-in form                                                            |
| `challenge.html`      | Cloudflare-style verification copy                                                         |
| `incomplete.html`     | Missing description (expected `UI_CHANGED`)                                                |

These fixtures exercise selector fallbacks, not live Handshake markup. Live
markup is covered by `tests/fixtures/live/job/` (captured 2026-10-25) and its
tests in `tests/unit/liveJobSelectors.test.ts`.
