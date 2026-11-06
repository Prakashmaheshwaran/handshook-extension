# E2E fixtures

Shared HTML/JSON for the mock Handshake site is generated in code by
[`tests/e2e/helpers/handshake.ts`](../helpers/handshake.ts) and served through
Playwright route interception. There are no static `.html` files here on purpose:

- one source of truth for selectors, scenarios, and request logging;
- no risk of a fixture drifting from the scenario config;
- no copied markup that could contain real account data.

Put feature-specific fixtures here only when a feature needs a static artifact that
cannot be produced by the helper (for example a captured, sanitized HTML snapshot of
a modal). Rules from `docs/TESTING.md` apply:

- one folder per feature (`tests/e2e/fixtures/review/`, `.../autopilot/`);
- add a `README.md` with source/date/tenant/sanitization notes;
- no real names, emails, tokens, cookies, resume content, or screenshots of a real
  account;
- name fixtures by behavior (`modal-with-three-docs.html`), not by date alone.

The sample data used by both unit tests and the mock site lives in
`src/test/mockData.ts`; add new sample jobs/documents/answers there first so E2E and
unit tests stay consistent.
