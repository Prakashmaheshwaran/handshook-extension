# Discovery fixtures (synthetic)

Hand-written, sanitized search pages for `src/handshake/discovery.ts`. No live
capture, tenant, user, or network data is included.

| File              | URL variant       | Covers                                                                                                                                 |
| ----------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `job-search.html` | `/job-search?q=…` | `/jobs/{id}` and `/stu/jobs/{id}` links, duplicate card (richest wins), malformed IDs/titles, enabled Next, sidebar/nav links excluded |
| `postings.html`   | `/postings`       | `data-job-id` card without an anchor, embedded `"jobId"` JSON inside a card, disabled Next                                             |
| `empty.html`      | `/job-search`     | Empty-state copy, zero cards, disabled Next                                                                                            |

Load into jsdom with `document.body.innerHTML = <fixture>` so computed styles
and `ownerDocument.defaultView` are available.
