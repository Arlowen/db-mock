package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

const registryColumns = `id,name,url,username,encrypted_password,encrypted_ca_certificate,
    encrypted_password<>'',encrypted_ca_certificate<>'',created_at,updated_at,last_tested_at,status,
    status_message,status_code`

func registryScan(item *domain.Registry) []any {
	return []any{&item.ID, &item.Name, &item.URL, &item.Username, &item.EncryptedPassword,
		&item.EncryptedCACertificate, &item.HasPassword, &item.HasCACertificate, &item.CreatedAt,
		&item.UpdatedAt, &item.LastTestedAt, &item.Status, &item.StatusMessage, &item.StatusCode}
}

// GetRegistry remains available only for instances and tasks that were bound
// to a private registry before the MVP removed registry management routes.
func (s *Store) GetRegistry(ctx context.Context, id uuid.UUID) (domain.Registry, error) {
	var item domain.Registry
	err := s.pool.QueryRow(ctx, "SELECT "+registryColumns+" FROM registries WHERE id=$1", id).Scan(registryScan(&item)...)
	return item, translate(err)
}
