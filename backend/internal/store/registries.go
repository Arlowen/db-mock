package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

type RegistryInput struct {
	ID                     uuid.UUID
	Name                   string
	URL                    string
	Username               string
	EncryptedPassword      string
	EncryptedCACertificate string
	ClearPassword          bool
	ClearCACertificate     bool
}

const registryColumns = `id,name,url,username,encrypted_password,encrypted_ca_certificate,
    encrypted_password<>'',encrypted_ca_certificate<>'',created_at,updated_at,last_tested_at,status,
    status_message,status_code`

func registryScan(item *domain.Registry) []any {
	return []any{&item.ID, &item.Name, &item.URL, &item.Username, &item.EncryptedPassword,
		&item.EncryptedCACertificate, &item.HasPassword, &item.HasCACertificate, &item.CreatedAt,
		&item.UpdatedAt, &item.LastTestedAt, &item.Status, &item.StatusMessage, &item.StatusCode}
}

func (s *Store) CreateRegistry(ctx context.Context, input RegistryInput) (domain.Registry, error) {
	if strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.URL) == "" {
		return domain.Registry{}, domain.ErrInvalid
	}
	var item domain.Registry
	if input.ID == uuid.Nil {
		input.ID = uuid.New()
	}
	item.ID = input.ID
	err := s.pool.QueryRow(ctx, `INSERT INTO registries(id,name,url,username,encrypted_password,encrypted_ca_certificate)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING `+registryColumns, item.ID, input.Name, input.URL,
		input.Username, input.EncryptedPassword, input.EncryptedCACertificate).Scan(registryScan(&item)...)
	if err != nil && strings.Contains(err.Error(), "registries_name_lower_idx") {
		return domain.Registry{}, domain.ErrConflict
	}
	return item, err
}

func (s *Store) GetRegistry(ctx context.Context, id uuid.UUID) (domain.Registry, error) {
	var item domain.Registry
	err := s.pool.QueryRow(ctx, "SELECT "+registryColumns+" FROM registries WHERE id=$1", id).Scan(registryScan(&item)...)
	return item, translate(err)
}

func (s *Store) ListRegistries(ctx context.Context) ([]domain.Registry, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+registryColumns+" FROM registries ORDER BY lower(name)")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Registry, 0)
	for rows.Next() {
		var item domain.Registry
		if err := rows.Scan(registryScan(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) UpdateRegistry(ctx context.Context, id uuid.UUID, input RegistryInput) (domain.Registry, error) {
	var item domain.Registry
	err := s.pool.QueryRow(ctx, `UPDATE registries SET name=$2,url=$3,username=$4,
		encrypted_password=CASE WHEN $7 THEN '' WHEN $5='' THEN encrypted_password ELSE $5 END,
		encrypted_ca_certificate=CASE WHEN $8 THEN '' WHEN $6='' THEN encrypted_ca_certificate ELSE $6 END,
		status='unknown',status_message='',status_code=NULL,last_tested_at=NULL,updated_at=now()
		WHERE id=$1 RETURNING `+registryColumns, id, input.Name, input.URL, input.Username,
		input.EncryptedPassword, input.EncryptedCACertificate, input.ClearPassword, input.ClearCACertificate).Scan(registryScan(&item)...)
	return item, translate(err)
}

func (s *Store) SetRegistryTestResult(ctx context.Context, id uuid.UUID, status, message string, statusCode int, checkedAt time.Time) error {
	var code *int
	if statusCode > 0 {
		code = &statusCode
	}
	result, err := s.pool.Exec(ctx, "UPDATE registries SET status=$2,status_message=$3,status_code=$4,last_tested_at=$5,updated_at=now() WHERE id=$1", id, status, message, code, checkedAt)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

func (s *Store) DeleteRegistry(ctx context.Context, id uuid.UUID) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var lockedID uuid.UUID
	if err = tx.QueryRow(ctx, "SELECT id FROM registries WHERE id=$1 FOR UPDATE", id).Scan(&lockedID); err != nil {
		return translate(err)
	}
	var inUse bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM instances WHERE configuration->>'registryId'=$1::text AND status<>'deleted')`, id).Scan(&inUse); err != nil {
		return err
	}
	if inUse {
		return fmt.Errorf("%w: registry is used by managed database instances", domain.ErrConflict)
	}
	var pendingUse bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE payload->>'registryId'=$1::text
		AND status IN ('queued','running'))`, id).Scan(&pendingUse); err != nil {
		return err
	}
	if pendingUse {
		return fmt.Errorf("%w: registry is referenced by an active instance operation", domain.ErrConflict)
	}
	if _, err = tx.Exec(ctx, "DELETE FROM registries WHERE id=$1", id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
