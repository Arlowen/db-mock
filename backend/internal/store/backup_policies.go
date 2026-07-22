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

type InstanceBackupPolicyInput struct {
	InstanceID     uuid.UUID
	Enabled        bool
	Frequency      string
	Weekday        int
	Hour           int
	Minute         int
	Timezone       string
	RetentionCount int
	NextRunAt      *time.Time
	ConfiguredBy   uuid.UUID
}

const backupPolicyColumns = `p.instance_id,p.enabled,p.frequency,p.weekday,p.hour,p.minute,p.timezone,
    p.retention_count,p.next_run_at,p.last_run_at,p.last_task_id,p.last_status,p.last_error,
    p.configured_by,u.username,p.created_at,p.updated_at`

func backupPolicyScan(item *domain.InstanceBackupPolicy) []any {
	return []any{&item.InstanceID, &item.Enabled, &item.Frequency, &item.Weekday, &item.Hour,
		&item.Minute, &item.Timezone, &item.RetentionCount, &item.NextRunAt, &item.LastRunAt,
		&item.LastTaskID, &item.LastStatus, &item.LastError, &item.ConfiguredBy,
		&item.ConfiguredByUsername, &item.CreatedAt, &item.UpdatedAt}
}

func (s *Store) GetInstanceBackupPolicy(ctx context.Context, instanceID uuid.UUID) (domain.InstanceBackupPolicy, error) {
	var item domain.InstanceBackupPolicy
	err := s.pool.QueryRow(ctx, `SELECT `+backupPolicyColumns+` FROM instance_backup_policies p
        JOIN users u ON u.id=p.configured_by WHERE p.instance_id=$1`, instanceID).Scan(backupPolicyScan(&item)...)
	return item, translate(err)
}

func (s *Store) UpsertInstanceBackupPolicy(ctx context.Context, input InstanceBackupPolicyInput) (domain.InstanceBackupPolicy, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.InstanceBackupPolicy{}, err
	}
	defer tx.Rollback(ctx)
	var status string
	if err = tx.QueryRow(ctx, `SELECT status FROM instances WHERE id=$1 FOR UPDATE`, input.InstanceID).Scan(&status); err != nil {
		return domain.InstanceBackupPolicy{}, translate(err)
	}
	if status == "deleted" || status == "deleting" {
		return domain.InstanceBackupPolicy{}, fmt.Errorf("%w: backup scheduling is unavailable for a deleted instance", domain.ErrConflict)
	}
	_, err = tx.Exec(ctx, `INSERT INTO instance_backup_policies
        (instance_id,enabled,frequency,weekday,hour,minute,timezone,retention_count,next_run_at,configured_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (instance_id) DO UPDATE SET enabled=excluded.enabled,frequency=excluded.frequency,
        weekday=excluded.weekday,hour=excluded.hour,minute=excluded.minute,timezone=excluded.timezone,
        retention_count=excluded.retention_count,next_run_at=CASE
            WHEN excluded.enabled AND instance_backup_policies.enabled
             AND instance_backup_policies.frequency=excluded.frequency
             AND instance_backup_policies.weekday=excluded.weekday
             AND instance_backup_policies.hour=excluded.hour
             AND instance_backup_policies.minute=excluded.minute
             AND instance_backup_policies.timezone=excluded.timezone
            THEN instance_backup_policies.next_run_at ELSE excluded.next_run_at END,
        configured_by=excluded.configured_by,updated_at=now()`, input.InstanceID, input.Enabled,
		input.Frequency, input.Weekday, input.Hour, input.Minute, input.Timezone, input.RetentionCount,
		input.NextRunAt, input.ConfiguredBy)
	if err != nil {
		return domain.InstanceBackupPolicy{}, translate(err)
	}
	var item domain.InstanceBackupPolicy
	err = tx.QueryRow(ctx, `SELECT `+backupPolicyColumns+` FROM instance_backup_policies p
        JOIN users u ON u.id=p.configured_by WHERE p.instance_id=$1`, input.InstanceID).Scan(backupPolicyScan(&item)...)
	if err != nil {
		return item, translate(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.InstanceBackupPolicy{}, err
	}
	return item, nil
}

func (s *Store) ListDueInstanceBackupPolicies(ctx context.Context, now time.Time, limit int) ([]domain.InstanceBackupPolicy, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	rows, err := s.pool.Query(ctx, `SELECT `+backupPolicyColumns+` FROM instance_backup_policies p
        JOIN users u ON u.id=p.configured_by
        WHERE p.enabled AND p.next_run_at <= $1 ORDER BY p.next_run_at,p.instance_id LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.InstanceBackupPolicy, 0)
	for rows.Next() {
		var item domain.InstanceBackupPolicy
		if err = rows.Scan(backupPolicyScan(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) CreateScheduledInstanceBackupTask(ctx context.Context, input TaskInput, policy domain.InstanceBackupPolicy,
	backup domain.InstanceBackup, expectedStatus, expectedDesiredState string, nextRun, now time.Time) (domain.InstanceBackup, domain.Task, error) {
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return backup, domain.Task{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return backup, domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	var status, desiredState string
	var hostID, versionID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT status,desired_state,host_id,template_version_id FROM instances WHERE id=$1 FOR UPDATE`,
		backup.InstanceID).Scan(&status, &desiredState, &hostID, &versionID); err != nil {
		return backup, domain.Task{}, translate(err)
	}
	if status != "running" && status != "stopped" {
		return backup, domain.Task{}, fmt.Errorf("%w: scheduled backup is waiting for a stable instance state", domain.ErrConflict)
	}
	if status != expectedStatus || desiredState != expectedDesiredState {
		return backup, domain.Task{}, fmt.Errorf("%w: instance state changed while queuing the scheduled backup", domain.ErrConflict)
	}
	var enabled bool
	var scheduledAt *time.Time
	var configuredBy uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT enabled,next_run_at,configured_by
        FROM instance_backup_policies WHERE instance_id=$1 FOR UPDATE`, backup.InstanceID).
		Scan(&enabled, &scheduledAt, &configuredBy); err != nil {
		return backup, domain.Task{}, translate(err)
	}
	if !enabled || scheduledAt == nil || scheduledAt.After(now) || policy.NextRunAt == nil || !scheduledAt.Equal(*policy.NextRunAt) {
		return backup, domain.Task{}, fmt.Errorf("%w: backup schedule changed before it could be queued", domain.ErrConflict)
	}
	input.RequestedBy = configuredBy
	backup.HostID, backup.TemplateVersionID = hostID, versionID
	backup.Status, backup.CreationType, backup.CreatedBy = "creating", "scheduled", configuredBy
	err = tx.QueryRow(ctx, `INSERT INTO instance_backups(id,instance_id,host_id,template_version_id,name,
        creation_type,status,remote_path,created_by) VALUES($1,$2,$3,$4,$5,'scheduled','creating',$6,$7)
        RETURNING created_at,updated_at`, backup.ID, backup.InstanceID, backup.HostID,
		backup.TemplateVersionID, backup.Name, backup.RemotePath, backup.CreatedBy).
		Scan(&backup.CreatedAt, &backup.UpdatedAt)
	if err != nil {
		return backup, domain.Task{}, translate(err)
	}
	task, err := createTaskInTx(ctx, tx, input, payload)
	if err != nil {
		return backup, task, err
	}
	if _, err = tx.Exec(ctx, `UPDATE instances SET status='backing_up',status_message='',updated_at=now()
        WHERE id=$1`, backup.InstanceID); err != nil {
		return backup, task, err
	}
	if _, err = tx.Exec(ctx, `UPDATE instance_backup_policies SET next_run_at=$2,last_run_at=$3,
        last_task_id=$4,last_status='queued',last_error='',updated_at=now() WHERE instance_id=$1`,
		backup.InstanceID, nextRun, *scheduledAt, task.ID); err != nil {
		return backup, task, err
	}
	if err = tx.Commit(ctx); err != nil {
		return backup, domain.Task{}, err
	}
	return backup, task, nil
}

func (s *Store) TrackInstanceBackupPolicyTask(ctx context.Context, instanceID, taskID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE instance_backup_policies SET last_task_id=$2,last_status='running',
        last_error='',updated_at=now() WHERE instance_id=$1`, instanceID, taskID)
	return err
}

func (s *Store) FinishInstanceBackupPolicyTask(ctx context.Context, instanceID, taskID uuid.UUID, status, message string) error {
	if status != "succeeded" && status != "failed" && status != "canceled" {
		return domain.ErrInvalid
	}
	_, err := s.pool.Exec(ctx, `UPDATE instance_backup_policies SET last_status=$3,last_error=$4,updated_at=now()
        WHERE instance_id=$1 AND last_task_id=$2`, instanceID, taskID, status, strings.TrimSpace(message))
	return err
}

func (s *Store) RestoreInstanceBackupPolicyAfterDelete(ctx context.Context, instanceID uuid.UUID, state *BackupPolicyState) error {
	if state == nil {
		return nil
	}
	if state.Enabled && state.NextRunAt == nil {
		return fmt.Errorf("%w: enabled backup policy recovery requires a next run time", domain.ErrInvalid)
	}
	_, err := s.pool.Exec(ctx, `UPDATE instance_backup_policies SET enabled=$2,
		next_run_at=CASE WHEN $2 THEN $3::timestamptz ELSE NULL END,updated_at=now() WHERE instance_id=$1`,
		instanceID, state.Enabled, state.NextRunAt)
	return err
}

func (s *Store) ListScheduledBackupsBeyondRetention(ctx context.Context, instanceID uuid.UUID, keep int) ([]domain.InstanceBackup, error) {
	if keep < 1 || keep > 100 {
		return nil, domain.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT `+backupColumns+` FROM instance_backups b
        JOIN template_versions tv ON tv.id=b.template_version_id JOIN users u ON u.id=b.created_by
        WHERE b.instance_id=$1 AND b.creation_type='scheduled' AND b.status='ready'
        ORDER BY b.completed_at DESC NULLS LAST,b.created_at DESC OFFSET $2 LIMIT 100`, instanceID, keep)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.InstanceBackup, 0)
	for rows.Next() {
		var item domain.InstanceBackup
		if err = rows.Scan(backupScan(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
