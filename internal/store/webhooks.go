package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

type WebhookInput struct {
	ID              uuid.UUID
	Name            string
	URL             string
	EncryptedSecret string
	ClearSecret     bool
	Events          json.RawMessage
	Enabled         bool
}

const webhookColumns = `id,name,url,encrypted_secret,encrypted_secret<>'',events,enabled,created_at,updated_at`

func webhookScan(item *domain.Webhook) []any {
	return []any{&item.ID, &item.Name, &item.URL, &item.EncryptedSecret, &item.HasSecret, &item.Events,
		&item.Enabled, &item.CreatedAt, &item.UpdatedAt}
}

func (s *Store) CreateWebhook(ctx context.Context, input WebhookInput) (domain.Webhook, error) {
	if len(input.Events) == 0 {
		input.Events = json.RawMessage(`["*"]`)
	}
	if input.ID == uuid.Nil {
		input.ID = uuid.New()
	}
	item := domain.Webhook{ID: input.ID}
	err := s.pool.QueryRow(ctx, `INSERT INTO webhooks(id,name,url,encrypted_secret,events,enabled)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING `+webhookColumns, item.ID, input.Name, input.URL,
		input.EncryptedSecret, input.Events, input.Enabled).Scan(webhookScan(&item)...)
	return item, err
}

func (s *Store) GetWebhook(ctx context.Context, id uuid.UUID) (domain.Webhook, error) {
	var item domain.Webhook
	err := s.pool.QueryRow(ctx, "SELECT "+webhookColumns+" FROM webhooks WHERE id=$1", id).Scan(webhookScan(&item)...)
	return item, translate(err)
}

func (s *Store) ListWebhooks(ctx context.Context) ([]domain.Webhook, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+webhookColumns+`,
		COALESCE((SELECT status FROM webhook_deliveries WHERE webhook_id=webhooks.id ORDER BY created_at DESC LIMIT 1),''),
		(SELECT updated_at FROM webhook_deliveries WHERE webhook_id=webhooks.id ORDER BY created_at DESC LIMIT 1),
		(SELECT count(*) FROM webhook_deliveries WHERE webhook_id=webhooks.id AND status='failed'),
		(SELECT count(*) FROM webhook_deliveries WHERE webhook_id=webhooks.id AND status IN ('pending','retrying','sending'))
		FROM webhooks ORDER BY lower(name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Webhook, 0)
	for rows.Next() {
		var item domain.Webhook
		values := append(webhookScan(&item), &item.LastDeliveryStatus, &item.LastDeliveryAt, &item.FailedDeliveries, &item.QueuedDeliveries)
		if err := rows.Scan(values...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) UpdateWebhook(ctx context.Context, id uuid.UUID, input WebhookInput) (domain.Webhook, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Webhook{}, err
	}
	defer tx.Rollback(ctx)
	var item domain.Webhook
	err = tx.QueryRow(ctx, `UPDATE webhooks SET name=$2,url=$3,
		encrypted_secret=CASE WHEN $7 THEN '' WHEN $4='' THEN encrypted_secret ELSE $4 END,events=$5,enabled=$6,updated_at=now()
		WHERE id=$1 RETURNING `+webhookColumns, id, input.Name, input.URL, input.EncryptedSecret,
		input.Events, input.Enabled, input.ClearSecret).Scan(webhookScan(&item)...)
	if err != nil {
		return domain.Webhook{}, translate(err)
	}
	if !input.Enabled {
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET status='canceled',
			error_message='webhook disabled before delivery',updated_at=now()
			WHERE webhook_id=$1 AND status IN ('pending','retrying')`, id); err != nil {
			return domain.Webhook{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Webhook{}, err
	}
	return item, nil
}

func (s *Store) DeleteWebhook(ctx context.Context, id uuid.UUID) error {
	result, err := s.pool.Exec(ctx, "DELETE FROM webhooks WHERE id=$1", id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

type WebhookDelivery struct {
	ID             uuid.UUID
	WebhookID      uuid.UUID
	EventID        uuid.UUID
	EventType      string
	Payload        json.RawMessage
	Status         string
	Attempts       int
	NextAttemptAt  time.Time
	ResponseStatus *int
	ResponseBody   string
	ErrorMessage   string
}

func (s *Store) EnqueueWebhookEvent(ctx context.Context, eventType string, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	eventID := uuid.New()
	rows, err := s.pool.Query(ctx, "SELECT "+webhookColumns+" FROM webhooks WHERE enabled=true")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var hook domain.Webhook
		if err := rows.Scan(webhookScan(&hook)...); err != nil {
			return err
		}
		var events []string
		_ = json.Unmarshal(hook.Events, &events)
		if !eventMatches(events, eventType) {
			continue
		}
		if _, err := s.pool.Exec(ctx, `INSERT INTO webhook_deliveries
            (id,webhook_id,event_id,event_type,payload) VALUES($1,$2,$3,$4,$5)`,
			uuid.New(), hook.ID, eventID, eventType, encoded); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Store) EnqueueWebhookFor(ctx context.Context, webhookID uuid.UUID, eventType string, payload any) (uuid.UUID, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return uuid.Nil, err
	}
	id := uuid.New()
	result, err := s.pool.Exec(ctx, `INSERT INTO webhook_deliveries(id,webhook_id,event_id,event_type,payload)
		SELECT $1,$2,$3,$4,$5 FROM webhooks WHERE id=$2 AND enabled=true`, id, webhookID, uuid.New(), eventType, encoded)
	if err != nil {
		return uuid.Nil, err
	}
	if result.RowsAffected() == 0 {
		if unavailable := s.webhookUnavailable(ctx, webhookID); unavailable != nil {
			return uuid.Nil, unavailable
		}
		return uuid.Nil, domain.ErrConflict
	}
	return id, nil
}

func (s *Store) ListWebhookDeliveries(ctx context.Context, webhookID uuid.UUID, limit int) ([]domain.WebhookDelivery, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `SELECT id,webhook_id,event_id,event_type,status,attempts,next_attempt_at,
		response_status,response_body,error_message,created_at,updated_at FROM webhook_deliveries
		WHERE webhook_id=$1 ORDER BY created_at DESC LIMIT $2`, webhookID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.WebhookDelivery, 0)
	for rows.Next() {
		var item domain.WebhookDelivery
		if err := rows.Scan(&item.ID, &item.WebhookID, &item.EventID, &item.EventType, &item.Status,
			&item.Attempts, &item.NextAttemptAt, &item.ResponseStatus, &item.ResponseBody,
			&item.ErrorMessage, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) RetryWebhookDelivery(ctx context.Context, webhookID, deliveryID uuid.UUID) error {
	result, err := s.pool.Exec(ctx, `UPDATE webhook_deliveries SET status='pending',attempts=0,
		next_attempt_at=now(),response_status=NULL,response_body='',error_message='',updated_at=now()
		WHERE id=$1 AND webhook_id=$2 AND status='failed'
		AND EXISTS(SELECT 1 FROM webhooks WHERE id=$2 AND enabled=true)`, deliveryID, webhookID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		if unavailable := s.webhookUnavailable(ctx, webhookID); unavailable != nil {
			return unavailable
		}
		return domain.ErrNotFound
	}
	return nil
}

func (s *Store) webhookUnavailable(ctx context.Context, id uuid.UUID) error {
	var enabled bool
	if err := s.pool.QueryRow(ctx, "SELECT enabled FROM webhooks WHERE id=$1", id).Scan(&enabled); err != nil {
		return translate(err)
	}
	if !enabled {
		return fmt.Errorf("%w: webhook is disabled", domain.ErrConflict)
	}
	return nil
}

func eventMatches(events []string, eventType string) bool {
	for _, event := range events {
		if event == "*" || event == eventType {
			return true
		}
	}
	return false
}

func (s *Store) ClaimWebhookDelivery(ctx context.Context) (WebhookDelivery, domain.Webhook, error) {
	if _, err := s.pool.Exec(ctx, `UPDATE webhook_deliveries AS delivery SET
		status=CASE WHEN hook.enabled THEN 'retrying' ELSE 'canceled' END,
		next_attempt_at=CASE WHEN hook.enabled THEN now() ELSE delivery.next_attempt_at END,
		error_message='delivery interrupted by control service restart',updated_at=now()
		FROM webhooks AS hook WHERE delivery.webhook_id=hook.id AND delivery.status='sending'
		AND delivery.updated_at < now() - interval '1 minute'`); err != nil {
		return WebhookDelivery{}, domain.Webhook{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WebhookDelivery{}, domain.Webhook{}, err
	}
	defer tx.Rollback(ctx)
	var item WebhookDelivery
	err = tx.QueryRow(ctx, `SELECT delivery.id,delivery.webhook_id,delivery.event_id,delivery.event_type,delivery.payload,
		delivery.status,delivery.attempts,delivery.next_attempt_at,delivery.response_status,delivery.response_body,delivery.error_message
		FROM webhook_deliveries AS delivery JOIN webhooks AS hook ON hook.id=delivery.webhook_id
		WHERE hook.enabled=true AND delivery.status IN ('pending','retrying') AND delivery.next_attempt_at<=now() ORDER BY delivery.created_at
		FOR UPDATE OF delivery SKIP LOCKED LIMIT 1`).Scan(&item.ID, &item.WebhookID, &item.EventID, &item.EventType,
		&item.Payload, &item.Status, &item.Attempts, &item.NextAttemptAt, &item.ResponseStatus,
		&item.ResponseBody, &item.ErrorMessage)
	if err != nil {
		return WebhookDelivery{}, domain.Webhook{}, translate(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE webhook_deliveries SET status='sending',attempts=attempts+1,updated_at=now()
        WHERE id=$1`, item.ID); err != nil {
		return WebhookDelivery{}, domain.Webhook{}, err
	}
	var hook domain.Webhook
	if err := tx.QueryRow(ctx, "SELECT "+webhookColumns+" FROM webhooks WHERE id=$1", item.WebhookID).Scan(webhookScan(&hook)...); err != nil {
		return WebhookDelivery{}, domain.Webhook{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WebhookDelivery{}, domain.Webhook{}, err
	}
	item.Attempts++
	return item, hook, nil
}

func (s *Store) FinishWebhookDelivery(ctx context.Context, id uuid.UUID, success bool, responseStatus int, responseBody, errorMessage string, attempts, maxAttempts int) error {
	status := "delivered"
	next := time.Now()
	if !success {
		if attempts >= maxAttempts {
			status = "failed"
		} else {
			status = "retrying"
			next = time.Now().Add(time.Duration(1<<min(attempts, 6)) * time.Minute)
		}
	}
	_, err := s.pool.Exec(ctx, `UPDATE webhook_deliveries SET status=$2,next_attempt_at=$3,
        response_status=$4,response_body=$5,error_message=$6,updated_at=now() WHERE id=$1`, id,
		status, next, responseStatus, responseBody, errorMessage)
	return err
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
