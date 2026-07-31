# Backup Request Recovery Audit

Date: 2026-07-31

## Slice objective

Make backup creation, restore, and deletion request failures durable and safely recoverable before a background task is queued. This slice addresses the daily-work problem where a short-lived notification disappears before an operator can understand whether data changed or whether it is safe to submit again.

## Baseline

The baseline was reproduced in an isolated DB Mock runtime with synthetic instance and backup metadata.

| Step | Interaction baseline | Page transitions | Baseline health |
| --- | --- | --- | --- |
| Create a backup | Open the create dialog, enter a name, submit | 0 | Unhealthy: a permission failure appeared only as a temporary notification. The dialog retained the name and allowed immediate resubmission without a durable explanation of impact or recovery. |
| Restore a backup | Open restore, type the exact instance name, submit | 0 | Unsafe: after a request conflict, the temporary notification disappeared while the destructive confirmation remained populated and the restore action could be submitted again. |
| Delete a backup | Open delete, type the exact backup name, submit | 0 | Unhealthy: the failure had no persistent location after the confirmation dialog closed and no state-aware retry path. |
| Continue after failure | Wait for the notification or close the dialog | 0 | Blocked: the operator had to infer whether a task existed, refresh manually, and repeat the full operation. |

Repeated input was limited to destructive confirmation text, but that text was retained after a failed restore or delete request when it should have been cleared. The primary missing context was the distinction between “request was not queued” and “background task failed.”

## Priorities

- P0: no new P0 was found in this slice. Server-side authorization and transactional state checks already remained the final write boundary.
- P1: create, restore, and delete pre-queue failures disappeared after a transient notification.
- P1: restore and delete confirmation text remained populated after failure, making an accidental immediate resubmission possible.
- P1: retry availability did not follow the latest instance, task, backup, version, permission, and error-code evidence.
- P2: at a 1024 px viewport, English recovery actions could squeeze the cause, impact, and recovery text into an excessively narrow column.

## Selected implementation

The selected slice preserves each failed backup request with:

- the failed action, stable API error code, server message, and affected backup;
- explicit cause, impact, and recovery guidance in the confirmation dialog and on the backups page;
- a state refresh after failure;
- cleared destructive confirmation text for restore and delete;
- retry only when the current instance, task inventory, backup inventory, backup state, template version, permission, and error code make retry safe;
- a fresh exact-name confirmation before retrying restore or delete;
- no retry for permission or missing-resource failures;
- responsive action placement below the recovery information at medium widths.

## Acceptance results

1. **Create request failure — healthy:** the entered backup name remains available, cause/impact/recovery stay visible, and permission failures do not offer retry.
2. **Restore request conflict — healthy:** no task or data change is claimed; exact confirmation is cleared; restore is disabled while the instance is unstable.
3. **Persistent recovery panel — healthy:** closing the dialog keeps the failure visible in the backups page without a page transition.
4. **Safe retry — healthy:** refreshing after the resource becomes stable exposes one retry entry, and retry reopens the original operation with an empty destructive confirmation.
5. **Delete request conflict — healthy:** the archive is described as retained, unrelated instance-log guidance is omitted, and retry only appears after the backup becomes deletable again.
6. **Permissions and responsive layout — healthy:** viewer sessions expose no create, restore, or delete action; Chinese and English layouts at 1440×900 and 1024×768 have no document-level horizontal overflow, overlapping action buttons, duplicate visible page headings, or visible console warnings/errors.

## Verification

- `npm run typecheck`
- `npm test` — 41 files, 183 tests
- `npm run build`
- `cd backend && go test ./...`
- Real-page in-app browser walkthrough at 1440×900 and 1024×768
- Synthetic admin and viewer role checks
- Conflict and permission failure checks without creating a real backup, restore, or deletion task

Current-run visual evidence is stored in `/tmp/dbmock_backup_request_audit.LQLBM3`. Key files:

- `02-baseline-create-request-failure-gone-1440.png`
- `04-baseline-restore-request-failure-gone-1440.png`
- `07-final-restore-request-persistent-1440.jpg`
- `09-final-create-request-forbidden-1440.jpg`
- `10-final-delete-request-failure-1024.jpg`
- `13-final-delete-retry-english-1024.jpg`
- `15-final-delete-retry-modal-english-1440.jpg`
- `16-final-viewer-english-1024.jpg`

## Evidence limits and remaining risks

- The walkthrough used synthetic PostgreSQL metadata, a documentation-only host address, and an isolated control-plane database. It did not connect to a company host or create, restore, or delete a real archive.
- The E2E scenario is encoded in the Playwright setup spec and type-checked, while the current visual walkthrough used the selected in-app browser rather than the Playwright CLI.
- Semantic alerts, dialogs, inputs, button labels, focus, and disabled states were inspected. This is not a complete keyboard, screen-reader, or WCAG conformance audit.
- The production bundle still emits the existing Vite large-chunk warning; this slice does not increase the number of entry chunks or change offline deployment behavior.
