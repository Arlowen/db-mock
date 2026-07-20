package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

const backupColumns = `b.id,b.instance_id,b.host_id,b.template_version_id,tv.version,b.name,b.status,
    b.remote_path,b.size_bytes,b.sha256,b.error_message,b.created_by,u.username,b.created_at,
    b.completed_at,b.updated_at`

func backupScan(item *domain.InstanceBackup) []any {
	return []any{&item.ID, &item.InstanceID, &item.HostID, &item.TemplateVersionID, &item.TemplateVersion,
		&item.Name, &item.Status, &item.RemotePath, &item.SizeBytes, &item.SHA256, &item.ErrorMessage,
		&item.CreatedBy, &item.CreatedByUsername, &item.CreatedAt, &item.CompletedAt, &item.UpdatedAt}
}

func (s *Store) GetInstanceBackup(ctx context.Context, id uuid.UUID) (domain.InstanceBackup, error) {
	var item domain.InstanceBackup
	err := s.pool.QueryRow(ctx, `SELECT `+backupColumns+` FROM instance_backups b
        JOIN template_versions tv ON tv.id=b.template_version_id JOIN users u ON u.id=b.created_by
        WHERE b.id=$1`, id).Scan(backupScan(&item)...)
	return item, translate(err)
}

func (s *Store) ListInstanceBackups(ctx context.Context, instanceID uuid.UUID) ([]domain.InstanceBackup, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+backupColumns+` FROM instance_backups b
        JOIN template_versions tv ON tv.id=b.template_version_id JOIN users u ON u.id=b.created_by
        WHERE b.instance_id=$1 ORDER BY b.created_at DESC`, instanceID)
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

func createTaskInTx(ctx context.Context, tx pgx.Tx, input TaskInput, payload []byte) (domain.Task, error) {
	item := domain.Task{ID: uuid.New()}
	err := tx.QueryRow(ctx, `INSERT INTO tasks(id,kind,resource_type,resource_id,requested_by,host_id,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+taskColumns, item.ID, input.Kind, input.ResourceType,
		input.ResourceID, input.RequestedBy, input.HostID, payload).Scan(taskScan(&item)...)
	if err != nil {
		return item, taskInsertError(err)
	}
	return item, nil
}

func (s *Store) CreateInstanceBackupTask(ctx context.Context, input TaskInput, backup domain.InstanceBackup, expectedStatus string) (domain.InstanceBackup, domain.Task, error) {
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return backup, domain.Task{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return backup, domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	var status string
	var hostID, versionID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT status,host_id,template_version_id FROM instances WHERE id=$1 FOR UPDATE`, backup.InstanceID).Scan(&status, &hostID, &versionID); err != nil {
		return backup, domain.Task{}, translate(err)
	}
	if status != expectedStatus {
		return backup, domain.Task{}, fmt.Errorf("%w: instance state changed while queuing the backup", domain.ErrConflict)
	}
	backup.HostID, backup.TemplateVersionID, backup.Status = hostID, versionID, "creating"
	err = tx.QueryRow(ctx, `INSERT INTO instance_backups(id,instance_id,host_id,template_version_id,name,status,
        remote_path,created_by) VALUES($1,$2,$3,$4,$5,'creating',$6,$7)
        RETURNING created_at,updated_at`, backup.ID, backup.InstanceID, backup.HostID, backup.TemplateVersionID,
		backup.Name, backup.RemotePath, backup.CreatedBy).Scan(&backup.CreatedAt, &backup.UpdatedAt)
	if err != nil {
		return backup, domain.Task{}, translate(err)
	}
	task, err := createTaskInTx(ctx, tx, input, payload)
	if err != nil {
		return backup, task, err
	}
	if _, err = tx.Exec(ctx, `UPDATE instances SET status='backing_up',status_message='',updated_at=now() WHERE id=$1`, backup.InstanceID); err != nil {
		return backup, task, err
	}
	if err = tx.Commit(ctx); err != nil {
		return backup, domain.Task{}, err
	}
	return backup, task, nil
}

func (s *Store) CreateInstanceRestoreTask(ctx context.Context, input TaskInput, instanceID, backupID uuid.UUID, expectedStatus string) (domain.InstanceBackup, domain.Task, error) {
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	var status string
	var versionID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT status,template_version_id FROM instances WHERE id=$1 FOR UPDATE`, instanceID).Scan(&status, &versionID); err != nil {
		return domain.InstanceBackup{}, domain.Task{}, translate(err)
	}
	if status != expectedStatus {
		return domain.InstanceBackup{}, domain.Task{}, fmt.Errorf("%w: instance state changed while queuing the restore", domain.ErrConflict)
	}
	var backup domain.InstanceBackup
	if err = tx.QueryRow(ctx, `SELECT `+backupColumns+` FROM instance_backups b
        JOIN template_versions tv ON tv.id=b.template_version_id JOIN users u ON u.id=b.created_by
        WHERE b.id=$1 FOR UPDATE OF b`, backupID).Scan(backupScan(&backup)...); err != nil {
		return backup, domain.Task{}, translate(err)
	}
	if backup.InstanceID != instanceID {
		return backup, domain.Task{}, domain.ErrNotFound
	}
	if backup.Status != "ready" {
		return backup, domain.Task{}, fmt.Errorf("%w: backup is not ready to restore", domain.ErrConflict)
	}
	if backup.TemplateVersionID != versionID {
		return backup, domain.Task{}, fmt.Errorf("%w: backup template version does not match the instance", domain.ErrConflict)
	}
	if _, err = tx.Exec(ctx, `UPDATE instance_backups SET status='restoring',error_message='',updated_at=now() WHERE id=$1`, backupID); err != nil {
		return backup, domain.Task{}, err
	}
	task, err := createTaskInTx(ctx, tx, input, payload)
	if err != nil {
		return backup, task, err
	}
	if _, err = tx.Exec(ctx, `UPDATE instances SET status='restoring',status_message='',updated_at=now() WHERE id=$1`, instanceID); err != nil {
		return backup, task, err
	}
	if err = tx.Commit(ctx); err != nil {
		return backup, domain.Task{}, err
	}
	backup.Status = "restoring"
	return backup, task, nil
}

func (s *Store) CreateInstanceBackupDeleteTask(ctx context.Context, input TaskInput, backupID uuid.UUID) (domain.InstanceBackup, domain.Task, error) {
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	var backup domain.InstanceBackup
	if err = tx.QueryRow(ctx, `SELECT `+backupColumns+` FROM instance_backups b
        JOIN template_versions tv ON tv.id=b.template_version_id JOIN users u ON u.id=b.created_by
        WHERE b.id=$1 FOR UPDATE OF b`, backupID).Scan(backupScan(&backup)...); err != nil {
		return backup, domain.Task{}, translate(err)
	}
	if backup.Status != "ready" && backup.Status != "failed" {
		return backup, domain.Task{}, fmt.Errorf("%w: backup cannot be deleted in its current state", domain.ErrConflict)
	}
	var pendingUse bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE payload->>'backupId'=$1::text
        AND status IN ('queued','running'))`, backupID).Scan(&pendingUse); err != nil {
		return backup, domain.Task{}, err
	}
	if pendingUse {
		return backup, domain.Task{}, fmt.Errorf("%w: backup is referenced by an active instance operation", domain.ErrConflict)
	}
	if _, err = tx.Exec(ctx, `UPDATE instance_backups SET status='deleting',updated_at=now() WHERE id=$1`, backupID); err != nil {
		return backup, domain.Task{}, err
	}
	task, err := createTaskInTx(ctx, tx, input, payload)
	if err != nil {
		return backup, task, err
	}
	if err = tx.Commit(ctx); err != nil {
		return backup, domain.Task{}, err
	}
	backup.Status = "deleting"
	return backup, task, nil
}

func (s *Store) SetInstanceBackupStatus(ctx context.Context, id uuid.UUID, status, message string) error {
	if status != "creating" && status != "ready" && status != "restoring" && status != "deleting" && status != "failed" {
		return domain.ErrInvalid
	}
	result, err := s.pool.Exec(ctx, `UPDATE instance_backups SET status=$2,error_message=$3,updated_at=now() WHERE id=$1`, id, status, strings.TrimSpace(message))
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

func (s *Store) CompleteInstanceBackup(ctx context.Context, id uuid.UUID, size int64, digest string) error {
	if size <= 0 || len(digest) != 64 {
		return domain.ErrInvalid
	}
	result, err := s.pool.Exec(ctx, `UPDATE instance_backups SET status='ready',size_bytes=$2,sha256=lower($3),
        error_message='',completed_at=now(),updated_at=now() WHERE id=$1 AND status='creating'`, id, size, digest)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrConflict
	}
	return err
}

func (s *Store) DeleteInstanceBackupRecord(ctx context.Context, id uuid.UUID) error {
	result, err := s.pool.Exec(ctx, `DELETE FROM instance_backups WHERE id=$1 AND status='deleting'`, id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrConflict
	}
	return err
}
