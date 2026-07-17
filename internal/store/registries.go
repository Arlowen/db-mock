package store

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

type RegistryInput struct {
	ID                     uuid.UUID
	Name                   string
	URL                    string
	Username               string
	EncryptedPassword      string
	EncryptedCACertificate string
}

const registryColumns = `id,name,url,username,encrypted_password,encrypted_ca_certificate,
    encrypted_password<>'',encrypted_ca_certificate<>'',created_at,updated_at,last_tested_at,status`

func registryScan(item *domain.Registry) []any {
	return []any{&item.ID, &item.Name, &item.URL, &item.Username, &item.EncryptedPassword,
		&item.EncryptedCACertificate, &item.HasPassword, &item.HasCACertificate, &item.CreatedAt,
		&item.UpdatedAt, &item.LastTestedAt, &item.Status}
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
        encrypted_password=CASE WHEN $5='' THEN encrypted_password ELSE $5 END,
        encrypted_ca_certificate=CASE WHEN $6='' THEN encrypted_ca_certificate ELSE $6 END,updated_at=now()
        WHERE id=$1 RETURNING `+registryColumns, id, input.Name, input.URL, input.Username,
		input.EncryptedPassword, input.EncryptedCACertificate).Scan(registryScan(&item)...)
	return item, translate(err)
}

func (s *Store) DeleteRegistry(ctx context.Context, id uuid.UUID) error {
	result, err := s.pool.Exec(ctx, "DELETE FROM registries WHERE id=$1", id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}
