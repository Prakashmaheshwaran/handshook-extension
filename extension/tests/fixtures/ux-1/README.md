# UX-1 action readiness fixtures

These are synthetic reconstructions of the owner-feedback coordinator's read-only observations on 2026-10-27, not raw account captures. All content is invented; there are no personal details, real employer names, job IDs from an account, credentials, or external URLs.

`job-late-actions.html` renders the detail contents after two seconds. It preserves the observed Rosetta `data-kind="button"` / `data-variant="primary"`, lowercase `Quick apply` aria-label and text, sticky duplicate under an `opacity: 0` ancestor, and Save / Share / More actions controls. DOM integration tests schedule the same template replacement explicitly because scripts inserted through jsdom `innerHTML` do not execute.

`job-external-rosetta.html` combines the already verified `Apply externally` label from the existing live fixture with that action structure. It does not claim a newly observed external application flow. Applied, closed, login and challenge variants remain defensive synthetic tests.
