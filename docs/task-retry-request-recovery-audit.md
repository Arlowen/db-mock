# Task Retry Request Recovery Audit

Date: 2026-07-31

## Slice objective

Make a failed **Retry task** request recoverable when the request is rejected or its response is uncertain before the operator can confirm that a new task entered the queue. This slice focuses on the canonical Task Center, where operators investigate and resume failed database work.

## Baseline

The baseline was reproduced in an isolated DB Mock control plane with synthetic PostgreSQL 17 metadata, a failed restart task, and a concurrent backup task on the same synthetic instance. The host address used the documentation-only `192.0.2.0/24` range; no company host, credential, database, SSH connection, Compose operation, or destructive action was used.

| Step | Interaction baseline | Page transitions | Baseline health |
| --- | --- | --- | --- |
| Inspect the failed task | Open Task Center and the failed restart task | 0 | Healthy: cause, impact, recovery advice, resource, and execution log are visible. |
| Submit retry while another operation owns the instance | Select **Retry task** | 0 | Unhealthy: the API returns `409 resource_conflict`, but the drawer shows only a generic action error. |
| Determine whether retry entered the queue | Read the generic server message | 0 | Blocked: there is no explicit statement that no retry task was created and no resource or data change came from this request. |
| Find the blocker | Close the drawer, search the task list, compare resources and timestamps | 1 or more | Unhealthy: the current backup task is not identified from the rejected request. |
| Continue safely | Wait, refresh, reopen the failed task, and try again | 1 or more | Unhealthy: the retry button remains enabled during the conflict and a network-ambiguous result has no evidence gate. |

## Priorities

- P0: no new P0 was found. Server-side operator authorization, resource task uniqueness, and transactional retry creation remain the write boundary.
- P1: a rejected retry request did not distinguish “no task created” from “request outcome unknown.”
- P1: the operator had to manually find the same-resource task that blocked retry.
- P1: retry remained enabled before current queue evidence showed that another submission was safe.
- P2: the generic alert did not organize cause, impact, recovery, and current-task evidence consistently with task execution failures.

## Selected implementation

The Task Center now keeps a structured retry-request recovery state:

- stable API rejection and network-ambiguous outcomes are separated;
- the complete unfiltered task list is refreshed after failure, independent of current list filters;
- retry lineage is matched by operation ID, task kind, resource, and creation time; if the first response was lost but a successor exists, the page follows the new task instead of reporting failure;
- an active same-resource task is shown as the blocker, can be opened directly, and disables another retry;
- a stable rejected request states that no new task was created and that the original task, resource state, and data were unchanged by the request;
- a network-ambiguous request requires two successful evidence checks with no successor or blocker before another retry is enabled;
- permission, identity, invalid-input, missing-task, and no-longer-retryable states do not expose another retry;
- closing the task drawer keeps the recovery state on the Task Center page; a successful retry clears it and returns to standard task tracking;
- viewer permissions remain unchanged: viewers can inspect non-sensitive task evidence but never receive retry actions.

## Acceptance results

1. **Rejected conflict — healthy:** a `409` shows **not queued**, localized cause, unchanged impact, stable error code, the blocking task, and a disabled retry action.
2. **Blocking evidence — healthy:** the current task opens directly; closing its drawer returns to the original recovery state on the Task Center.
3. **Safe continuation — healthy:** refreshing after the blocker finishes changes the recovery state to safe and re-enables retry without reloading the page.
4. **Accepted continuation — healthy:** the automated routed flow accepts the next retry, opens the queued successor, and removes the old request alert.
5. **Ambiguous response — healthy:** unit coverage follows a matching operation-lineage successor and requires two successful evidence checks before resubmission when no successor is found.
6. **Permissions and terminal states — healthy:** missing, forbidden, unauthorized, invalid-input, and no-longer-retryable evidence never enables retry; existing viewer controls remain unchanged.
7. **Responsive and bilingual layout — healthy:** Chinese at 1440×1000 and English at 1024×900 have one page heading, one visible primary retry action per context, visible drawer footer actions, no document or drawer overflow, and no console errors.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- standalone TypeScript compilation of `frontend/tests/e2e/setup.spec.ts`
- `cd backend && go test ./...`
- real-page in-app browser walkthrough at 1440×1000 and 1024×900
- synthetic retry-conflict, blocker completion, evidence refresh, and safe-retry checks without executing a real database operation

Current-run evidence is stored in `/tmp/dbmock_task_retry_audit.mc0PLM`.

Key files:

- `01-baseline-failed-task-1440.png`
- `02-baseline-retry-conflict-1440.png`
- `11-final-zh-blocked-1440.png`
- `12-final-en-ready-1024.png`

## Evidence limits and remaining risks

- The walkthrough proves control-plane state and UI behavior only. It does not validate real SSH, Compose, database restart, backup timing, or company network policy.
- The automated flow uses routed synthetic responses for conflict, blocker completion, and accepted retry; the runtime visual check uses isolated PostgreSQL metadata.
- Dashboard, instance detail, and host recovery now reuse this canonical evidence model; the cross-entry baseline and validation are recorded in [Cross-entry Task Retry Recovery Audit](cross-entry-task-retry-recovery-audit-2026-08-02.md).
- A real disposable host is still required to validate the time between a blocking operation finishing and a retry worker starting under normal company load.
