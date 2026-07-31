# Instance Change Request Recovery Audit

Date: 2026-07-31

## Slice objective

Make database upgrade and runtime-configuration request failures durable and safely recoverable before a background task is queued. This slice addresses the daily-work ambiguity where an operator submits a disruptive change, sees a temporary notification, and then has to inspect Tasks or logs to determine whether the database was changed.

## Baseline

The baseline was reproduced in an isolated DB Mock control plane with a synthetic PostgreSQL 17 instance, a documentation-only host address, a same-major upgrade target, and no company credentials or resources.

| Step | Interaction baseline | Page transitions | Baseline health |
| --- | --- | --- | --- |
| Prepare runtime change | Open **More actions → Change runtime configuration**, change CPU, confirm live capacity | 0 | Healthy: current and requested reservations, downtime, rollback behavior, and capacity are visible. |
| Submit while another operation owns the instance | Select **Apply configuration** | 0 | Unhealthy: the API rejects the request before task creation, but the page only shows a temporary notification. |
| Determine whether anything changed | Wait for the notification to disappear | 0 | Blocked: there is no durable statement that no task was created and CPU, environment, restart policy, and runtime state remain unchanged. |
| Continue safely | Inspect Tasks or logs, return to the instance, reopen the form | 2 or more | Unhealthy: the operator has to infer whether retry is safe and may repeat the full draft. |
| Submit an upgrade during a queue outage | Select target version and image source, then confirm | 0 | Unhealthy: the selected version remains in memory, but no persistent cause, impact, or recovery path distinguishes a rejected request from a failed upgrade task. |

## Priorities

- P0: no new P0 was found. Server-side operator authorization, instance/host locks, active-task uniqueness, and transactional task creation remain the write boundary.
- P1: upgrade and runtime-configuration pre-queue failures disappeared after a temporary notification.
- P1: the page did not state whether a task, stop, snapshot, version switch, resource update, or environment change occurred.
- P1: a draft opened before concurrent state changed could still appear locally valid until the next refresh; the form did not directly explain the blocking task.
- P2: adding durable recovery content to already tall dialogs required bounded scrolling so footer actions remain visible at desktop and tablet widths.

## Selected implementation

The selected slice adds one shared request-recovery model for `upgrade` and `reconfigure`:

- preserve the failed action, stable API error code, localized server reason, and the current form draft;
- refresh instance, template, host, image-source, and task evidence after rejection;
- state explicitly that the failed request created no task and did not change the database version, image, runtime state, resources, environment, or restart policy;
- keep cause, impact, and recovery guidance visible in the dialog and on the instance page after the dialog closes;
- show the current task when refresh finds a concurrent operation and disable resubmission until it clears;
- block retry for missing resources and permission failures, and require the current instance state and refreshed form evidence to remain valid;
- invalidate an upgrade target that disappears or becomes unavailable during refresh;
- return to the standard task progress and failure-recovery path only after the API accepts a task.

## Acceptance results

1. **Runtime request rejection — healthy:** the changed CPU and environment draft remain visible, the dialog states that no runtime task was created, and the original runtime settings are identified as unchanged.
2. **Concurrent operation — healthy:** refreshed task evidence is shown as the current blocker, the submit action is disabled, and the operator can open that task or refresh in place.
3. **Upgrade queue rejection — healthy:** the selected target version and image source remain visible with an explicit statement that no stop, snapshot, template switch, or image switch occurred.
4. **Persistent recovery — healthy:** closing either dialog keeps the same cause, impact, and recovery information on the instance page.
5. **Safe retry — healthy:** retry is available only when the account still has operator permission, no operation task is active, the instance remains running/stopped/degraded, and the refreshed target remains valid.
6. **Responsive and bilingual layout — healthy:** the instance detail and both dialogs keep their footer actions visible through bounded body scrolling and avoid document-level horizontal overflow at 1440 px and 1024 px widths in Chinese and English.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- standalone TypeScript compilation of `frontend/tests/e2e/setup.spec.ts`
- `cd backend && go test ./...`
- real-page in-app browser walkthrough at 1440×1000 and 1024×900
- synthetic runtime-change and upgrade queue rejection checks without creating or modifying a real database

Current-run visual evidence is stored in `/tmp/dbmock_change_request_audit.R0Ex55`. Key files:

- `01-baseline-runtime-form-1440.png`
- `02-baseline-runtime-rejection-1440.png`
- `03-after-runtime-rejection-1440.png`
- `04-after-runtime-page-recovery-1440.png`
- `05-final-runtime-rejection-1440.png`
- `06-final-upgrade-rejection-1024.png`
- `07-final-runtime-rejection-english-1024.png`

## Evidence limits and remaining risks

- The walkthrough used synthetic metadata, a reserved documentation address, and an isolated PostgreSQL control plane. It did not connect to a company host or execute Compose, a database restart, a snapshot, or an upgrade.
- The E2E scenario encodes request conflicts, temporary queue outages, preserved drafts, current-task blocking, refresh, and retry. It was type-checked; the visual walkthrough used the selected in-app browser rather than the Playwright CLI.
- Real SSH/image/Compose behavior and recovery timing still require an explicitly authorized disposable test host.
- The production bundle still emits the existing Vite large-chunk warning; this slice does not alter offline deployment topology.
