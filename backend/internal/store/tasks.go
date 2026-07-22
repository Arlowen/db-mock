package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/pika/db-mock/internal/domain"
)

type TaskInput struct {
	Kind         string
	ResourceType string
	ResourceID   *uuid.UUID
	RequestedBy  uuid.UUID
	HostID       *uuid.UUID
	Payload      any
}

const taskColumns = `id,kind,status,resource_type,resource_id,requested_by,host_id,progress,stage,message,
    payload,result,error_code,error_message,cancelable,cancel_asked,attempts,created_at,started_at,finished_at,updated_at`

func taskScan(item *domain.Task) []any {
	return []any{&item.ID, &item.Kind, &item.Status, &item.ResourceType, &item.ResourceID,
		&item.RequestedBy, &item.HostID, &item.Progress, &item.Stage, &item.Message, &item.Payload,
		&item.Result, &item.ErrorCode, &item.ErrorMessage, &item.Cancelable, &item.CancelAsked,
		&item.Attempts, &item.CreatedAt, &item.StartedAt, &item.FinishedAt, &item.UpdatedAt}
}

type taskSourceReferences struct {
	ImageArtifactID *uuid.UUID `json:"imageArtifactId"`
	RegistryID      *uuid.UUID `json:"registryId"`
	BackupID        *uuid.UUID `json:"backupId"`
}

func lockTaskSourceReferences(ctx context.Context, tx pgx.Tx, kind string, payload []byte) error {
	var references taskSourceReferences
	if err := json.Unmarshal(payload, &references); err != nil {
		return fmt.Errorf("%w: task payload is not valid JSON", domain.ErrInvalid)
	}
	if references.ImageArtifactID != nil {
		var status string
		if err := tx.QueryRow(ctx, "SELECT status FROM image_artifacts WHERE id=$1 FOR KEY SHARE", *references.ImageArtifactID).Scan(&status); err != nil {
			return translate(err)
		}
		if status != "ready" {
			return fmt.Errorf("%w: offline image is not available", domain.ErrConflict)
		}
	}
	if references.RegistryID != nil {
		var id uuid.UUID
		if err := tx.QueryRow(ctx, "SELECT id FROM registries WHERE id=$1 FOR KEY SHARE", *references.RegistryID).Scan(&id); err != nil {
			return translate(err)
		}
	}
	if references.BackupID != nil {
		var status string
		if err := tx.QueryRow(ctx, "SELECT status FROM instance_backups WHERE id=$1 FOR KEY SHARE", *references.BackupID).Scan(&status); errors.Is(err, pgx.ErrNoRows) && kind == "instance.backup.delete" {
			return nil
		} else if err != nil {
			return translate(err)
		}
		if status == "deleting" && kind != "instance.backup.delete" {
			return fmt.Errorf("%w: backup is being deleted", domain.ErrConflict)
		}
	}
	return nil
}

func (s *Store) CreateTask(ctx context.Context, input TaskInput) (domain.Task, error) {
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return domain.Task{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockTaskSourceReferences(ctx, tx, input.Kind, payload); err != nil {
		return domain.Task{}, err
	}
	item := domain.Task{ID: uuid.New()}
	err = tx.QueryRow(ctx, `INSERT INTO tasks(id,kind,resource_type,resource_id,requested_by,host_id,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+taskColumns, item.ID, input.Kind, input.ResourceType,
		input.ResourceID, input.RequestedBy, input.HostID, payload).Scan(taskScan(&item)...)
	if err != nil {
		return item, taskInsertError(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Task{}, err
	}
	return item, nil
}

func (s *Store) CreateInstanceActionTask(ctx context.Context, input TaskInput, instanceID uuid.UUID, expectedStatus, operationStatus string) (domain.Task, error) {
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return domain.Task{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	var currentStatus string
	if err = tx.QueryRow(ctx, "SELECT status FROM instances WHERE id=$1 FOR UPDATE", instanceID).Scan(&currentStatus); err != nil {
		return domain.Task{}, translate(err)
	}
	if currentStatus != expectedStatus {
		return domain.Task{}, fmt.Errorf("%w: instance state changed while queuing the operation", domain.ErrConflict)
	}
	if operationStatus == "deleting" {
		payload, err = captureDeleteBackupPolicy(ctx, tx, instanceID, payload)
		if err != nil {
			return domain.Task{}, err
		}
	}
	if err = lockTaskSourceReferences(ctx, tx, input.Kind, payload); err != nil {
		return domain.Task{}, err
	}
	item := domain.Task{ID: uuid.New()}
	err = tx.QueryRow(ctx, `INSERT INTO tasks(id,kind,resource_type,resource_id,requested_by,host_id,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+taskColumns, item.ID, input.Kind, input.ResourceType,
		input.ResourceID, input.RequestedBy, input.HostID, payload).Scan(taskScan(&item)...)
	if err != nil {
		return domain.Task{}, taskInsertError(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE instances SET status=$2,status_message='',updated_at=now() WHERE id=$1`, instanceID, operationStatus); err != nil {
		return domain.Task{}, err
	}
	if operationStatus == "deleting" {
		if _, err = tx.Exec(ctx, `UPDATE instance_backup_policies SET enabled=false,next_run_at=NULL,
            updated_at=now() WHERE instance_id=$1`, instanceID); err != nil {
			return domain.Task{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Task{}, err
	}
	return item, nil
}

func captureDeleteBackupPolicy(ctx context.Context, tx pgx.Tx, instanceID uuid.UUID, payload []byte) ([]byte, error) {
	var enabled bool
	var nextRunAt *time.Time
	err := tx.QueryRow(ctx, `SELECT enabled,next_run_at FROM instance_backup_policies
		WHERE instance_id=$1 FOR UPDATE`, instanceID).Scan(&enabled, &nextRunAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return payload, nil
	}
	if err != nil {
		return nil, err
	}
	var values map[string]json.RawMessage
	if err = json.Unmarshal(payload, &values); err != nil || values == nil {
		return nil, fmt.Errorf("%w: task payload is not a JSON object", domain.ErrInvalid)
	}
	values["previousBackupPolicyEnabled"], err = json.Marshal(enabled)
	if err != nil {
		return nil, err
	}
	if nextRunAt != nil {
		values["previousBackupPolicyNextRunAt"], err = json.Marshal(nextRunAt)
		if err != nil {
			return nil, err
		}
	}
	return json.Marshal(values)
}

func taskInsertError(err error) error {
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && databaseError.ConstraintName == "tasks_active_resource_idx" {
		return fmt.Errorf("%w: another operation is already queued or running for this resource", domain.ErrConflict)
	}
	return translate(err)
}

func (s *Store) GetTask(ctx context.Context, id uuid.UUID) (domain.Task, error) {
	var item domain.Task
	err := s.pool.QueryRow(ctx, "SELECT "+taskColumns+" FROM tasks WHERE id=$1", id).Scan(taskScan(&item)...)
	return item, translate(err)
}

func (s *Store) ListTasks(ctx context.Context, status, resourceType string, resourceID *uuid.UUID, limit int) ([]domain.Task, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, "SELECT "+taskColumns+` FROM tasks WHERE ($1='' OR status=$1)
        AND ($2='' OR resource_type=$2) AND ($3::uuid IS NULL OR resource_id=$3)
        ORDER BY created_at DESC LIMIT $4`, status, resourceType, resourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Task, 0)
	for rows.Next() {
		var item domain.Task
		if err := rows.Scan(taskScan(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) HasActiveResourceTask(ctx context.Context, resourceType string, resourceID uuid.UUID) (bool, error) {
	var active bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks
        WHERE resource_type=$1 AND resource_id=$2 AND status IN ('queued','running'))`, resourceType, resourceID).Scan(&active)
	return active, err
}

func (s *Store) ClaimTask(ctx context.Context) (domain.Task, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	var item domain.Task
	err = tx.QueryRow(ctx, `SELECT `+taskColumns+` FROM tasks WHERE status='queued'
		AND (host_id IS NULL OR NOT EXISTS (
			SELECT 1 FROM tasks AS running WHERE running.host_id=tasks.host_id AND running.status='running'
		))
		ORDER BY created_at FOR UPDATE OF tasks SKIP LOCKED LIMIT 1`).Scan(taskScan(&item)...)
	if err != nil {
		return domain.Task{}, translate(err)
	}
	// Serialize destructive tasks per host while still allowing parallel work on different hosts.
	if item.HostID != nil {
		// Lock the durable host row before rechecking active work. Without this lock,
		// concurrent claim transactions can both observe no running task and start two
		// destructive operations on the same host.
		var lockedHostID uuid.UUID
		if err := tx.QueryRow(ctx, "SELECT id FROM hosts WHERE id=$1 FOR NO KEY UPDATE", item.HostID).Scan(&lockedHostID); err != nil {
			return domain.Task{}, translate(err)
		}
		var running bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE host_id=$1 AND status='running' AND id<>$2)`,
			item.HostID, item.ID).Scan(&running); err != nil {
			return domain.Task{}, err
		}
		if running {
			return domain.Task{}, domain.ErrNotFound
		}
	}
	err = tx.QueryRow(ctx, `UPDATE tasks SET status='running',stage='starting',progress=1,cancelable=true,
        started_at=coalesce(started_at,now()),updated_at=now(),attempts=attempts+1 WHERE id=$1 RETURNING `+taskColumns,
		item.ID).Scan(taskScan(&item)...)
	if err != nil {
		return domain.Task{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Task{}, err
	}
	return item, nil
}

func (s *Store) UpdateTask(ctx context.Context, id uuid.UUID, progress int, stage, message string, cancelable bool) error {
	_, err := s.pool.Exec(ctx, `UPDATE tasks SET progress=$2,stage=$3,message=$4,cancelable=$5,
        updated_at=now() WHERE id=$1 AND status='running'`, id, progress, stage, message, cancelable)
	return err
}

func (s *Store) AdvanceTaskStage(ctx context.Context, id uuid.UUID, progress int, stage, message string, cancelable bool) (bool, error) {
	result, err := s.pool.Exec(ctx, `UPDATE tasks SET progress=$2,stage=$3,message=$4,cancelable=$5,
        updated_at=now() WHERE id=$1 AND status='running' AND cancel_asked=false`, id, progress, stage, message, cancelable)
	if err != nil {
		return false, err
	}
	if result.RowsAffected() > 0 {
		return false, nil
	}
	task, err := s.GetTask(ctx, id)
	if err != nil {
		return false, err
	}
	if task.Status == "running" && task.CancelAsked {
		return true, nil
	}
	return false, domain.ErrConflict
}

func (s *Store) FinishTask(ctx context.Context, id uuid.UUID, status string, result any, errorCode, errorMessage string) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		encoded = []byte(`{}`)
	}
	progress := 100
	if status == "failed" || status == "canceled" || status == "interrupted" {
		progress = 0
	}
	_, err = s.pool.Exec(ctx, `UPDATE tasks SET status=$2,progress=CASE WHEN $3=100 THEN 100 ELSE progress END,
        stage=$2,result=$4,error_code=$5,error_message=$6,cancelable=false,finished_at=now(),updated_at=now()
        WHERE id=$1`, id, status, progress, encoded, errorCode, errorMessage)
	return err
}

func (s *Store) AddTaskLog(ctx context.Context, id uuid.UUID, level, message string) error {
	_, err := s.pool.Exec(ctx, "INSERT INTO task_logs(task_id,level,message) VALUES($1,$2,$3)", id, level, message)
	return err
}

func (s *Store) ListTaskLogs(ctx context.Context, id uuid.UUID, after int64, limit int) ([]domain.TaskLog, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx, `SELECT id,task_id,level,message,created_at FROM task_logs
        WHERE task_id=$1 AND id>$2 ORDER BY id LIMIT $3`, id, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.TaskLog, 0)
	for rows.Next() {
		var item domain.TaskLog
		if err := rows.Scan(&item.ID, &item.TaskID, &item.Level, &item.Message, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) RequestTaskCancel(ctx context.Context, id uuid.UUID) error {
	result, err := s.pool.Exec(ctx, `UPDATE tasks SET cancel_asked=true,updated_at=now()
        WHERE id=$1 AND status IN ('queued','running') AND cancelable=true`, id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrConflict
	}
	return err
}

func (s *Store) RetryTask(ctx context.Context, id uuid.UUID, userID uuid.UUID) (domain.Task, error) {
	old, err := s.GetTask(ctx, id)
	if err != nil {
		return domain.Task{}, err
	}
	if old.Status != "failed" && old.Status != "interrupted" && old.Status != "canceled" {
		return domain.Task{}, domain.ErrConflict
	}
	payload, err := taskRetryPayload(old.Payload, old.ID, old.Status)
	if err != nil {
		return domain.Task{}, err
	}
	if old.ResourceID != nil {
		active, activeErr := s.HasActiveResourceTask(ctx, old.ResourceType, *old.ResourceID)
		if activeErr != nil {
			return domain.Task{}, activeErr
		}
		if active {
			return domain.Task{}, fmt.Errorf("%w: another operation is already queued or running for this resource", domain.ErrConflict)
		}
	}
	return s.CreateTask(ctx, TaskInput{Kind: old.Kind, ResourceType: old.ResourceType, ResourceID: old.ResourceID,
		RequestedBy: userID, HostID: old.HostID, Payload: payload})
}

func taskRetryPayload(payload json.RawMessage, previousTaskID uuid.UUID, previousStatus string) (json.RawMessage, error) {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(payload, &values); err != nil || values == nil {
		return nil, fmt.Errorf("%w: task payload is not a JSON object", domain.ErrInvalid)
	}
	operationID := previousTaskID
	if encoded, ok := values["operationId"]; ok {
		if err := json.Unmarshal(encoded, &operationID); err != nil || operationID == uuid.Nil {
			return nil, fmt.Errorf("%w: task operation lineage is invalid", domain.ErrInvalid)
		}
	}
	encodedOperationID, err := json.Marshal(operationID)
	if err != nil {
		return nil, err
	}
	values["operationId"] = encodedOperationID
	if previousStatus == "interrupted" {
		values["reuseRollbackSnapshot"] = json.RawMessage("true")
	} else {
		delete(values, "reuseRollbackSnapshot")
	}
	encoded, err := json.Marshal(values)
	return json.RawMessage(encoded), err
}

func (s *Store) InterruptRunningTasks(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `WITH interrupted AS (
        UPDATE tasks SET status='interrupted',stage='interrupted',cancelable=false,
        error_code='application_restarted',error_message='The control service restarted while the task was running',
		finished_at=now(),updated_at=now() WHERE status='running' RETURNING id
    )
    UPDATE instance_backup_policies SET last_status='failed',
        last_error='The control service restarted while the scheduled backup was running',updated_at=now()
    WHERE last_task_id IN (SELECT id FROM interrupted)`)
	return err
}

func (s *Store) CleanupSessions(ctx context.Context) (int64, error) {
	result, err := s.pool.Exec(ctx, "DELETE FROM sessions WHERE expires_at<now()")
	return result.RowsAffected(), err
}

func (s *Store) TouchTaskMessage(ctx context.Context, id uuid.UUID, message string) error {
	_, err := s.pool.Exec(ctx, "UPDATE tasks SET message=$2,updated_at=$3 WHERE id=$1", id, message, time.Now())
	return err
}
