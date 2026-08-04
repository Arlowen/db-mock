package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

// GetImageArtifact remains available only so instances and tasks created by an
// older release can finish or recover. The MVP has no route that creates or
// selects an offline image artifact for a new deployment.
func (s *Store) GetImageArtifact(ctx context.Context, id uuid.UUID) (domain.ImageArtifact, error) {
	var item domain.ImageArtifact
	err := s.pool.QueryRow(ctx, `SELECT id,name,filename,path,size_bytes,sha256,format,image_refs,architectures,
        status,created_by,created_at,last_used_at,(SELECT count(*) FROM instances WHERE configuration->>'imageArtifactId'=image_artifacts.id::text AND status<>'deleted')
        FROM image_artifacts WHERE id=$1`, id).Scan(&item.ID,
		&item.Name, &item.Filename, &item.Path, &item.SizeBytes, &item.SHA256, &item.Format,
		&item.ImageRefs, &item.Architectures, &item.Status, &item.CreatedBy, &item.CreatedAt, &item.LastUsedAt, &item.UsedByCount)
	return item, translate(err)
}

func (s *Store) MarkImageArtifactUsed(ctx context.Context, id uuid.UUID) error {
	result, err := s.pool.Exec(ctx, "UPDATE image_artifacts SET last_used_at=now() WHERE id=$1 AND status='ready'", id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}
