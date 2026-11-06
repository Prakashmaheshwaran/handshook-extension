# UX-6 fixtures

Synthetic reconstructions of structure relayed by the coordinator from the owner's
supervised Handshake observation on 2026-10-27. No real job, account, document,
employer, or captured page data is included.

- `job-one-click.html`: plain primary Apply without dialog semantics, plus an
  invisible sticky copy. The observed click submitted immediately.
- `job-applied.html`: persistent Rosetta alert, Applied on date heading, Withdraw
  application and disabled Apply with `aria-disabled="true"`.
- `submitted-toast.html`: transient submission alert.

A disabled Apply alone can also mean loading or ineligibility; success requires
new positive status text. Real dialogs for other job types remain unobserved.
