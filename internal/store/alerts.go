package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

type AlertInput struct {
	Severity     string
	Type         string
	ResourceType string
	ResourceID   uuid.UUID
	Title        string
	Message      string
	Details      any
}

func (s *Store) CreateAlert(ctx context.Context, input AlertInput) (domain.Alert, bool, error) {
	var existing domain.Alert
	err := s.pool.QueryRow(ctx, `SELECT id,severity,type,resource_type,resource_id,title,message,details,status,
        created_at,acknowledged_at,resolved_at FROM alerts WHERE type=$1 AND resource_type=$2 AND resource_id=$3
        AND status<>'resolved' ORDER BY created_at DESC LIMIT 1`, input.Type, input.ResourceType, input.ResourceID).Scan(
		&existing.ID, &existing.Severity, &existing.Type, &existing.ResourceType, &existing.ResourceID,
		&existing.Title, &existing.Message, &existing.Details, &existing.Status, &existing.CreatedAt,
		&existing.AcknowledgedAt, &existing.ResolvedAt)
	if err == nil {
		return existing, false, nil
	}
	if err != pgx.ErrNoRows {
		return domain.Alert{}, false, err
	}
	details, _ := json.Marshal(input.Details)
	item := domain.Alert{ID: uuid.New()}
	err = s.pool.QueryRow(ctx, `INSERT INTO alerts(id,severity,type,resource_type,resource_id,title,message,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,severity,type,resource_type,resource_id,title,message,
        details,status,created_at,acknowledged_at,resolved_at`, item.ID, input.Severity, input.Type,
		input.ResourceType, input.ResourceID, input.Title, input.Message, details).Scan(&item.ID, &item.Severity,
		&item.Type, &item.ResourceType, &item.ResourceID, &item.Title, &item.Message, &item.Details,
		&item.Status, &item.CreatedAt, &item.AcknowledgedAt, &item.ResolvedAt)
	return item, true, err
}

func (s *Store) ListAlerts(ctx context.Context, status string, limit int) ([]domain.Alert, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `SELECT id,severity,type,resource_type,resource_id,title,message,details,
        status,created_at,acknowledged_at,resolved_at FROM alerts WHERE ($1='' OR status=$1)
        ORDER BY created_at DESC LIMIT $2`, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Alert, 0)
	for rows.Next() {
		var item domain.Alert
		if err := rows.Scan(&item.ID, &item.Severity, &item.Type, &item.ResourceType, &item.ResourceID,
			&item.Title, &item.Message, &item.Details, &item.Status, &item.CreatedAt, &item.AcknowledgedAt,
			&item.ResolvedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SetAlertStatus(ctx context.Context, id uuid.UUID, status string) error {
	result, err := s.pool.Exec(ctx, `UPDATE alerts SET status=$2,
        acknowledged_at=CASE WHEN $2='acknowledged' THEN now() ELSE acknowledged_at END,
        resolved_at=CASE WHEN $2='resolved' THEN now() ELSE resolved_at END WHERE id=$1`, id, status)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

func (s *Store) ResolveAlerts(ctx context.Context, resourceType string, resourceID uuid.UUID, alertType string) error {
	_, err := s.pool.Exec(ctx, `UPDATE alerts SET status='resolved',resolved_at=now()
        WHERE resource_type=$1 AND resource_id=$2 AND ($3='' OR type=$3) AND status<>'resolved'`,
		resourceType, resourceID, alertType)
	return err
}
