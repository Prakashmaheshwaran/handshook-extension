# Mock Handshake

The E2E suite does **not** run a local fixture server. Playwright route interception
serves every `https://app.joinhandshake.com/**` request from
[`tests/e2e/helpers/handshake.ts`](../../tests/e2e/helpers/handshake.ts), which keeps
the origin, cookie domain, and content-script match patterns realistic.

```
npm run build          # once, produces .output/chrome-mv3
npm run test:e2e -- tests/e2e/smoke.spec.ts
```

## Using the mock in a test

```ts
import { expect, test } from '../../helpers/extension';
import { installHandshakeRoutes } from '../../helpers/handshake';

test('example', async ({ context }) => {
  const mock = await installHandshakeRoutes(context, 'form-two-docs');
  const page = await context.newPage();

  await page.goto(mock.searchUrl());
  await page.getByTestId('next-page').click();
  await page.goto(mock.jobUrl('900002'));

  expect(mock.pagesServed).toContain('/job-search');
  expect(mock.requestsFor('/jobs/900002/applications')).toHaveLength(0);
});
```

## Scenarios

| Scenario                 | Serves                                               |
| ------------------------ | ---------------------------------------------------- |
| `search-10-jobs`         | 10 cards, next link, empty page 2, mixed apply types |
| `quick-apply`            | Quick Apply submits without a modal                  |
| `form-two-docs`          | Form requiring resume + cover letter                 |
| `form-questions`         | Form with text/select/radio screening questions      |
| `external`               | Apply Externally link, no in-page submit             |
| `already-applied`        | Applied banner, no apply control                     |
| `closed`                 | Closed banner, no apply control                      |
| `rate-limited`           | 429 on application POST and job detail API           |
| `login-redirect`         | Protected pages redirect to `/login` until sign-in   |
| `slow-modal`             | Modal after 500ms, documents after 600ms             |
| `missing-selector`       | Job detail without apply controls                    |
| `form-transcript`        | Form requiring resume + transcript                   |
| `ambiguous-confirmation` | POST succeeds but no confirmation banner             |

Controller switches for failure tests: `setApiMode`, `setApplicationStatus`,
`setDocuments`, `setSearchJobs`, `setLoggedIn`, `setJobApplied`,
`setConfirmationMode`. Call `dispose()` to remove the route handler before installing
another scenario on the same context.

A successful POST marks the job applied server-side, so reloading the job page shows
the applied banner. `setConfirmationMode('none')` keeps the submitted page from
rendering a confirmation, which models a slow/ambiguous response; the write-ahead
record is then reconciled on reload. `setJobApplied` flips that banner for seeded
recovery scenarios.

## Why no server

A localhost server would need a second origin, fake DNS, or a proxy to keep the
content-script match pattern working, and it would add a process to CI. Route
interception is deterministic, inspectable (`mock.requests`, `mock.pagesServed`), and
cannot reach the network. If a future feature genuinely needs a long-lived origin
(e.g. service-worker streaming tests), add it here behind an explicit test flag and
reuse the same renderers from the helper.
