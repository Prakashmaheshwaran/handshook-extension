# Document correctness fixtures

Synthetic Handshake application markup, created 2026-10-27; no live tenant or personal data.

- `quick-apply-document-choice.html`: a one-click action with a visible selected resume and an advertised normal form alternative. The selected Quick Apply resume differs from the chosen fixture resume.
- `document-combobox.html`: a document picker with duplicate titles and distinct IDs. Test handlers either commit an ID to the trigger or deliberately leave it unchanged to exercise verification timeouts.

These are defensive selector fixtures, not evidence of live Handshake markup. Existing single-click, native-select, and optional-document fixtures are also used by the document regression suite.
