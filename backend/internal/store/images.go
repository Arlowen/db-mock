package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

func (s *Store) CreateUpload(ctx context.Context, upload domain.Upload) (domain.Upload, error) {
	if upload.ID == uuid.Nil {
		upload.ID = uuid.New()
	}
	err := s.pool.QueryRow(ctx, `INSERT INTO uploads(id,filename,temporary_path,total_bytes,received_bytes,
        expected_sha256,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING created_at,updated_at`, upload.ID, upload.Filename, upload.TemporaryPath, upload.TotalBytes,
		upload.ReceivedBytes, upload.ExpectedSHA256, upload.Status, upload.CreatedBy).Scan(&upload.CreatedAt, &upload.UpdatedAt)
	return upload, err
}

func (s *Store) GetUpload(ctx context.Context, id uuid.UUID) (domain.Upload, error) {
	var item domain.Upload
	err := s.pool.QueryRow(ctx, `SELECT id,filename,temporary_path,total_bytes,received_bytes,expected_sha256,
        status,created_by,created_at,updated_at FROM uploads WHERE id=$1`, id).Scan(&item.ID, &item.Filename,
		&item.TemporaryPath, &item.TotalBytes, &item.ReceivedBytes, &item.ExpectedSHA256, &item.Status,
		&item.CreatedBy, &item.CreatedAt, &item.UpdatedAt)
	return item, translate(err)
}

func (s *Store) UpdateUploadProgress(ctx context.Context, id uuid.UUID, received int64, status string) error {
	_, err := s.pool.Exec(ctx, `UPDATE uploads SET received_bytes=$2,status=$3,updated_at=now() WHERE id=$1`,
		id, received, status)
	return err
}

func (s *Store) DeleteUpload(ctx context.Context, id uuid.UUID) (string, error) {
	var path string
	err := s.pool.QueryRow(ctx, "DELETE FROM uploads WHERE id=$1 AND status='uploading' RETURNING temporary_path", id).Scan(&path)
	return path, translate(err)
}

func (s *Store) CreateImageArtifact(ctx context.Context, item domain.ImageArtifact) (domain.ImageArtifact, error) {
	if item.ID == uuid.Nil {
		item.ID = uuid.New()
	}
	err := s.pool.QueryRow(ctx, `INSERT INTO image_artifacts(id,name,filename,path,size_bytes,sha256,format,
		image_refs,architectures,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT(sha256) DO UPDATE SET sha256=image_artifacts.sha256 WHERE image_artifacts.status='ready'
		RETURNING id,name,filename,path,size_bytes,
		sha256,format,image_refs,architectures,status,created_by,created_at,last_used_at`, item.ID, item.Name,
		item.Filename, item.Path, item.SizeBytes, item.SHA256, item.Format, item.ImageRefs, item.Architectures,
		item.Status, item.CreatedBy).Scan(&item.ID, &item.Name, &item.Filename, &item.Path, &item.SizeBytes,
		&item.SHA256, &item.Format, &item.ImageRefs, &item.Architectures, &item.Status, &item.CreatedBy,
		&item.CreatedAt, &item.LastUsedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, fmt.Errorf("%w: offline image is currently being deleted", domain.ErrConflict)
	}
	return item, err
}

func (s *Store) MarkImageArtifactUsed(ctx context.Context, id uuid.UUID) error {
	result, err := s.pool.Exec(ctx, "UPDATE image_artifacts SET last_used_at=now() WHERE id=$1 AND status='ready'", id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

func (s *Store) GetImageArtifact(ctx context.Context, id uuid.UUID) (domain.ImageArtifact, error) {
	var item domain.ImageArtifact
	err := s.pool.QueryRow(ctx, `SELECT id,name,filename,path,size_bytes,sha256,format,image_refs,architectures,
        status,created_by,created_at,last_used_at,(SELECT count(*) FROM instances WHERE configuration->>'imageArtifactId'=image_artifacts.id::text AND status<>'deleted')
        FROM image_artifacts WHERE id=$1`, id).Scan(&item.ID,
		&item.Name, &item.Filename, &item.Path, &item.SizeBytes, &item.SHA256, &item.Format,
		&item.ImageRefs, &item.Architectures, &item.Status, &item.CreatedBy, &item.CreatedAt, &item.LastUsedAt, &item.UsedByCount)
	return item, translate(err)
}

func (s *Store) ListImageArtifacts(ctx context.Context) ([]domain.ImageArtifact, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,name,filename,path,size_bytes,sha256,format,image_refs,architectures,
        status,created_by,created_at,last_used_at,(SELECT count(*) FROM instances WHERE configuration->>'imageArtifactId'=image_artifacts.id::text AND status<>'deleted')
        FROM image_artifacts ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.ImageArtifact, 0)
	for rows.Next() {
		var item domain.ImageArtifact
		if err := rows.Scan(&item.ID, &item.Name, &item.Filename, &item.Path, &item.SizeBytes,
			&item.SHA256, &item.Format, &item.ImageRefs, &item.Architectures, &item.Status,
			&item.CreatedBy, &item.CreatedAt, &item.LastUsedAt, &item.UsedByCount); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListUnusedImageArtifacts(ctx context.Context, before time.Time) ([]domain.ImageArtifact, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,name,filename,path,size_bytes,sha256,format,image_refs,architectures,
		status,created_by,created_at,last_used_at,0 FROM image_artifacts
		WHERE status='ready' AND COALESCE(last_used_at,created_at)<$1 AND NOT EXISTS
		(SELECT 1 FROM instances WHERE configuration->>'imageArtifactId'=image_artifacts.id::text AND status<>'deleted')
		AND NOT EXISTS (SELECT 1 FROM tasks WHERE payload->>'imageArtifactId'=image_artifacts.id::text
			AND status IN ('queued','running'))
		ORDER BY COALESCE(last_used_at,created_at),created_at`, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.ImageArtifact, 0)
	for rows.Next() {
		var item domain.ImageArtifact
		if err := rows.Scan(&item.ID, &item.Name, &item.Filename, &item.Path, &item.SizeBytes,
			&item.SHA256, &item.Format, &item.ImageRefs, &item.Architectures, &item.Status,
			&item.CreatedBy, &item.CreatedAt, &item.LastUsedAt, &item.UsedByCount); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) BeginDeleteImageArtifact(ctx context.Context, id uuid.UUID) (domain.ImageArtifact, error) {
	return s.beginDeleteImageArtifact(ctx, id, nil)
}

func (s *Store) BeginDeleteUnusedImageArtifact(ctx context.Context, id uuid.UUID, before time.Time) (domain.ImageArtifact, error) {
	return s.beginDeleteImageArtifact(ctx, id, &before)
}

func (s *Store) beginDeleteImageArtifact(ctx context.Context, id uuid.UUID, before *time.Time) (domain.ImageArtifact, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.ImageArtifact{}, err
	}
	defer tx.Rollback(ctx)
	var item domain.ImageArtifact
	if err = tx.QueryRow(ctx, `SELECT id,name,filename,path,size_bytes,sha256,format,image_refs,architectures,
		status,created_by,created_at,last_used_at FROM image_artifacts WHERE id=$1 FOR UPDATE`, id).Scan(
		&item.ID, &item.Name, &item.Filename, &item.Path, &item.SizeBytes, &item.SHA256, &item.Format,
		&item.ImageRefs, &item.Architectures, &item.Status, &item.CreatedBy, &item.CreatedAt, &item.LastUsedAt); err != nil {
		return domain.ImageArtifact{}, translate(err)
	}
	var inUse bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM instances WHERE configuration->>'imageArtifactId'=$1::text AND status<>'deleted')`, id).Scan(&inUse); err != nil {
		return domain.ImageArtifact{}, err
	}
	if inUse {
		return domain.ImageArtifact{}, fmt.Errorf("%w: offline image is used by managed database instances", domain.ErrConflict)
	}
	var pendingUse bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE payload->>'imageArtifactId'=$1::text
		AND status IN ('queued','running'))`, id).Scan(&pendingUse); err != nil {
		return domain.ImageArtifact{}, err
	}
	if pendingUse {
		return domain.ImageArtifact{}, fmt.Errorf("%w: offline image is referenced by an active instance operation", domain.ErrConflict)
	}
	if before != nil {
		activityAt := item.CreatedAt
		if item.LastUsedAt != nil {
			activityAt = *item.LastUsedAt
		}
		if (item.Status != "ready" && item.Status != "deleting") || !activityAt.Before(*before) {
			return domain.ImageArtifact{}, fmt.Errorf("%w: offline image is no longer eligible for cleanup", domain.ErrConflict)
		}
	}
	if item.Status != "ready" && item.Status != "deleting" {
		return domain.ImageArtifact{}, fmt.Errorf("%w: offline image cannot be deleted in its current state", domain.ErrConflict)
	}
	if _, err = tx.Exec(ctx, "UPDATE image_artifacts SET status='deleting' WHERE id=$1", id); err != nil {
		return domain.ImageArtifact{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.ImageArtifact{}, err
	}
	item.Status = "deleting"
	return item, nil
}

func (s *Store) CompleteDeleteImageArtifact(ctx context.Context, id uuid.UUID) error {
	result, err := s.pool.Exec(ctx, "DELETE FROM image_artifacts WHERE id=$1 AND status='deleting'", id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

func (s *Store) RestoreImageArtifact(ctx context.Context, id uuid.UUID) error {
	result, err := s.pool.Exec(ctx, "UPDATE image_artifacts SET status='ready' WHERE id=$1 AND status='deleting'", id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

func (s *Store) DeleteExpiredUploads(ctx context.Context, before time.Time) ([]string, error) {
	rows, err := s.pool.Query(ctx, `DELETE FROM uploads WHERE updated_at<$1 AND status<>'complete' RETURNING temporary_path`, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, rows.Err()
}
