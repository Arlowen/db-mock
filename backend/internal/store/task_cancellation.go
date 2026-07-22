package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

// QueuedTaskRecovery describes the metadata that must be restored when a
// queued instance task is canceled before its handler has a chance to run.
// The task transition and every supplied recovery update are committed in the
// same transaction, so an instance cannot remain stuck in an operation state.
type QueuedTaskRecovery struct {
	PreserveResources     bool
	InstanceID            *uuid.UUID
	InstanceStatus        string
	InstanceDesiredState  string
	InstanceStatusMessage string
	RuntimeConfiguration  *InstanceRuntimeConfiguration
	BackupID              *uuid.UUID
	BackupStatus          string
	BackupStatusMessage   string
	BackupPolicyID        *uuid.UUID
	DeletePolicy          *BackupPolicyState
}

type BackupPolicyState struct {
	Enabled   bool
	NextRunAt *time.Time
}

type taskCancellationReferences struct {
	OperationID    *uuid.UUID `json:"operationId"`
	InstanceID     *uuid.UUID `json:"instanceId"`
	BackupID       *uuid.UUID `json:"backupId"`
	BackupPolicyID *uuid.UUID `json:"backupPolicyId"`
}

// CancelTask immediately completes a queued task or records a cancellation
// request for a running task. Stateful instance tasks require recovery data
// while queued; running handlers remain responsible for their own rollback.
func (s *Store) CancelTask(ctx context.Context, id uuid.UUID, recovery *QueuedTaskRecovery) (domain.Task, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.Task{}, err
	}
	defer tx.Rollback(ctx)

	var task domain.Task
	err = tx.QueryRow(ctx, "SELECT "+taskColumns+" FROM tasks WHERE id=$1 FOR UPDATE", id).Scan(taskScan(&task)...)
	if err != nil {
		return domain.Task{}, translate(err)
	}
	if !task.Cancelable || (task.Status != "queued" && task.Status != "running") {
		return domain.Task{}, domain.ErrConflict
	}

	if task.Status == "running" {
		err = tx.QueryRow(ctx, `UPDATE tasks SET cancel_asked=true,updated_at=now() WHERE id=$1
			RETURNING `+taskColumns, id).Scan(taskScan(&task)...)
		if err != nil {
			return domain.Task{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return domain.Task{}, err
		}
		return task, nil
	}

	if strings.HasPrefix(task.Kind, "instance.") {
		if recovery == nil {
			return domain.Task{}, fmt.Errorf("%w: queued instance task cancellation requires resource recovery", domain.ErrInvalid)
		}
		if err = validateQueuedTaskRecovery(task, *recovery); err != nil {
			return domain.Task{}, err
		}
		if err = applyQueuedTaskRecovery(ctx, tx, *recovery, task.ID); err != nil {
			return domain.Task{}, err
		}
	}

	const canceledMessage = "Task canceled before execution"
	err = tx.QueryRow(ctx, `UPDATE tasks SET status='canceled',stage='canceled',message=$2,
		cancelable=false,cancel_asked=true,error_code='canceled',error_message=$2,
		finished_at=now(),updated_at=now() WHERE id=$1 RETURNING `+taskColumns, id, canceledMessage).
		Scan(taskScan(&task)...)
	if err != nil {
		return domain.Task{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO task_logs(task_id,level,message) VALUES($1,'info',$2)`, id, canceledMessage); err != nil {
		return domain.Task{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Task{}, err
	}
	return task, nil
}

func validateQueuedTaskRecovery(task domain.Task, recovery QueuedTaskRecovery) error {
	var references taskCancellationReferences
	if err := json.Unmarshal(task.Payload, &references); err != nil {
		return fmt.Errorf("%w: task payload is not valid JSON", domain.ErrInvalid)
	}
	if recovery.InstanceID == nil || references.InstanceID == nil || *recovery.InstanceID != *references.InstanceID {
		return fmt.Errorf("%w: task instance recovery does not match its payload", domain.ErrInvalid)
	}
	if task.ResourceType == "instance" && (task.ResourceID == nil || *task.ResourceID != *recovery.InstanceID) {
		return fmt.Errorf("%w: task instance recovery does not match its resource", domain.ErrInvalid)
	}
	if !sameOptionalUUID(recovery.BackupID, references.BackupID) ||
		!sameOptionalUUID(recovery.BackupPolicyID, references.BackupPolicyID) {
		return fmt.Errorf("%w: task backup recovery does not match its payload", domain.ErrInvalid)
	}
	if recovery.PreserveResources && references.OperationID == nil {
		return fmt.Errorf("%w: only a retry may preserve current resources during queued cancellation", domain.ErrInvalid)
	}
	return nil
}

func applyQueuedTaskRecovery(ctx context.Context, tx pgx.Tx, recovery QueuedTaskRecovery, taskID uuid.UUID) error {
	if recovery.PreserveResources {
		return nil
	}
	if recovery.RuntimeConfiguration != nil {
		if err := validateRuntimeConfiguration(*recovery.RuntimeConfiguration); err != nil {
			return err
		}
		result, err := tx.Exec(ctx, `UPDATE instances SET cpu=$2,memory_bytes=$3,reserved_disk_bytes=$4,
			configuration=$5,auto_restart=$6,status=$7,desired_state=$8,status_message=$9,updated_at=now()
			WHERE id=$1 AND status<>'deleted'`, *recovery.InstanceID, recovery.RuntimeConfiguration.CPU,
			recovery.RuntimeConfiguration.MemoryBytes, recovery.RuntimeConfiguration.ReservedDiskBytes,
			recovery.RuntimeConfiguration.Configuration, recovery.RuntimeConfiguration.AutoRestart,
			recovery.InstanceStatus, recovery.InstanceDesiredState, recovery.InstanceStatusMessage)
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			return domain.ErrNotFound
		}
	} else {
		result, err := tx.Exec(ctx, `UPDATE instances SET status=$2,
			desired_state=CASE WHEN $3='' THEN desired_state ELSE $3 END,status_message=$4,
			last_healthy_at=CASE WHEN $2='running' THEN now() ELSE last_healthy_at END,
			restart_failures=CASE WHEN $2='running' THEN 0 ELSE restart_failures END,updated_at=now()
			WHERE id=$1 AND status<>'deleted'`, *recovery.InstanceID, recovery.InstanceStatus,
			recovery.InstanceDesiredState, recovery.InstanceStatusMessage)
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			return domain.ErrNotFound
		}
	}
	if recovery.BackupID != nil {
		result, err := tx.Exec(ctx, `UPDATE instance_backups SET status=$2,error_message=$3,updated_at=now()
			WHERE id=$1`, *recovery.BackupID, recovery.BackupStatus, strings.TrimSpace(recovery.BackupStatusMessage))
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			return domain.ErrNotFound
		}
	}
	if recovery.BackupPolicyID != nil {
		if _, err := tx.Exec(ctx, `UPDATE instance_backup_policies SET last_status='canceled',
			last_error='Scheduled backup was canceled before execution',updated_at=now()
			WHERE instance_id=$1 AND last_task_id=$2`, *recovery.BackupPolicyID, taskID); err != nil {
			return err
		}
	}
	if recovery.DeletePolicy != nil {
		if recovery.DeletePolicy.Enabled && recovery.DeletePolicy.NextRunAt == nil {
			return fmt.Errorf("%w: enabled backup policy recovery requires a next run time", domain.ErrInvalid)
		}
		if _, err := tx.Exec(ctx, `UPDATE instance_backup_policies SET enabled=$2,
			next_run_at=CASE WHEN $2 THEN $3::timestamptz ELSE NULL END,updated_at=now() WHERE instance_id=$1`,
			*recovery.InstanceID, recovery.DeletePolicy.Enabled, recovery.DeletePolicy.NextRunAt); err != nil {
			return err
		}
	}
	return nil
}
