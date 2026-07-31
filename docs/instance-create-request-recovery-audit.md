# Instance Create Request Recovery Audit

Date: 2026-07-31

## Slice objective

Make database creation failures understandable and safely recoverable when the server rejects the request before a background task is queued. This slice addresses the daily-work problem where an operator could not tell whether anything was created, whether the retained draft was still valid, or which part of the deployment configuration needed attention.

## Baseline

The baseline was reproduced in an isolated DB Mock runtime with a synthetic PostgreSQL catalog, one synthetic host, and no instances or tasks.

| Step | Interaction baseline | Page transitions | Baseline health |
| --- | --- | --- | --- |
| Open database creation | Select **Create database** from the empty instance list | 0 | Healthy: the workflow stays in one drawer and preserves the selected catalog context. |
| Select a template | Open the catalog choice and select PostgreSQL 17 | 0 | Healthy: template and version context continue into the deployment draft. |
| Enter deployment context | Enter the instance name and purpose; owner and seven-day expiry are defaulted | 0 | Mostly healthy: two deliberate inputs are required and reusable lifecycle context is prefilled. |
| Review target and resources | Accept the recommended host, standard resources, automatic port, generated password, and runtime defaults | 0 | Healthy while scheduling data remains current. |
| Submit the request | Select **Create** after four **Next** actions | 0 | Unhealthy when host state changes immediately before submission: the UI showed a raw conflict without durable impact, recovery, error-code, or retry-safety guidance. |
| Continue after rejection | Interpret the transient failure and decide whether to submit again | 0 | Blocked: the operator had to infer whether an instance or task existed, refresh resources manually, and risk repeating an unsafe request. |

The common happy-path draft takes about nine primary interactions after opening the workflow: select a template, enter name and purpose, move through four steps, and submit. It requires no route transition. The failure baseline added no navigation but created a hard reasoning break because refreshed host, capacity, port, image, name, and permission evidence was not tied back to the retained draft.

## Priorities

- P0: no new P0 was found in this slice. Server-side authorization, scheduling validation, and transactional instance/task creation remain the final write boundary.
- P1: a rejected create request did not explicitly say that no instance or task was created.
- P1: the retained draft could be resubmitted without proving that host, resource, port, image, name, and permission context remained valid.
- P1: the error did not provide a stable code or direct route back to the invalid wizard step.
- P1: refreshing after the rejection could re-run the URL create-intent continuation and redirect to host setup, discarding the active recovery context.
- P2: recovery cause, impact, guidance, and actions needed a stacked layout at medium widths to avoid compressed copy and ambiguous button placement.

## Selected implementation

The selected slice preserves the failed deployment draft and adds:

- a durable recovery alert with the localized server cause, explicit impact, recovery guidance, and stable API error code;
- an immediate refresh of instances, templates, hosts, projects, images, and registries after rejection;
- validation of the retained template/version, host capacity, automatic or explicit port, image source, draft fields, permissions, and matching instance name;
- direct navigation to the wizard step that needs adjustment;
- a matching-instance route when refreshed evidence shows that the requested name now exists;
- direct retry only for an explicit server rejection when the refreshed draft is still valid and no same-name instance exists;
- no direct retry for ambiguous network outcomes, authorization failures, missing resources, or invalid input;
- protection against the create-intent URL redirecting away while the recovery drawer is open;
- responsive recovery actions and complete Chinese/English copy.

## Acceptance results

1. **Explicit impact — healthy:** a server rejection states that no new instance or task was created and that the deployment draft is retained.
2. **Actionable cause — healthy:** the alert preserves the localized server message and stable `resource_conflict` code, then points back to resources and host selection.
3. **Unsafe retry — healthy:** after the synthetic host goes offline, current state refreshes automatically, the footer **Create** action is disabled, and an adjustment action is visible.
4. **Safe retry — healthy:** after the host returns online, **Refresh deployment status** revalidates the unchanged draft and enables **Create** without repeating name, purpose, owner, expiry, resources, or database options.
5. **Continuation integrity — healthy:** the URL remains on the instance create flow while the failure is active; refresh does not redirect to host setup or discard the recovery context.
6. **Permissions — healthy:** a viewer receives HTTP 403 for instance creation, sees the read-only explanation, and has no create action or administrative navigation.
7. **Responsive and localized layout — healthy:** Chinese at 1440×900 and 1024×768 and English at 1024×768 show no document-level horizontal overflow, overlapping or floating actions, repeated visible draft headings, clipped recovery content, or visible console warnings/errors.

## Product design assessment

### Strengths

- The workflow remains a single, sequential surface with meaningful defaults and no page hopping on the happy path.
- Failure language now distinguishes a request rejection from a queued task failure.
- The recovery actions stay next to the evidence they depend on, and the primary submit action visually reflects retry safety.

### UX risks

- Automatic host monitoring can make retry eligibility change quickly; the UI therefore requires an explicit refresh immediately before resubmission.
- An ambiguous client/network failure intentionally withholds retry because the client cannot prove whether the server committed the request. The operator must refresh and inspect matching instances before continuing.
- Very long infrastructure messages still depend on server-side wording quality, although wrapping and stable error codes keep the alert usable.

### Accessibility risks

- The recovery panel uses semantic alert, button, heading, disabled-state, and code elements, and visible focus was inspected.
- A full keyboard sequence, screen-reader announcement order, zoom matrix, and WCAG conformance audit remain outside this slice.

### Opportunity areas

- Apply the same explicit “committed versus not queued” contract to any remaining request mutations that still rely on transient notifications.
- Add request correlation identifiers to operator-facing recovery details when backend observability supports them.
- Measure how often host drift, port drift, or duplicate names block create requests during the internal trial, then prioritize the dominant cause.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- `cd backend && go test ./...`
- Real-page in-app browser walkthrough at 1440×900 and 1024×768
- Chinese and English create-rejection checks
- Synthetic admin and viewer role checks
- Safe and unsafe retry-state checks without creating an instance or task

Current-run visual evidence is stored in `/tmp/dbmock_create_request_audit.w1sxqG`. Key files:

- `01-baseline-create-review-1440.png`
- `02-baseline-create-request-failure-1440.png`
- `03-baseline-create-request-failure-scrolled-1440.png`
- `05-final-create-failure-1440.png`
- `06-final-create-retry-ready-1440.png`
- `07-final-create-failure-1024.png`
- `08-final-create-failure-english-1024.png`
- `09-final-viewer-instances-1024.png`

## Evidence limits and remaining risks

- The walkthrough used synthetic PostgreSQL metadata, a documentation-only host address, and an isolated control-plane database. It did not connect to a company host or create a real database instance.
- The E2E scenario is encoded in the Playwright setup spec and type-checked, while the current visual walkthrough used the selected in-app browser rather than the Playwright CLI.
- The viewport, overflow, visible headings, dialog state, actions, disabled state, and browser console were inspected. This is not a complete accessibility conformance audit.
- The production bundle still emits the existing Vite large-chunk warning; this slice does not change offline deployment behavior.
