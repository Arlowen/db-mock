package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/domain"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

func translate(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && databaseError.Code == "23505" {
		return domain.ErrConflict
	}
	return err
}

func (s *Store) IsInitialized(ctx context.Context) (bool, error) {
	var count int
	err := s.pool.QueryRow(ctx, "SELECT count(*) FROM users WHERE disabled_at IS NULL").Scan(&count)
	return count > 0, err
}

func (s *Store) Dashboard(ctx context.Context) (domain.Dashboard, error) {
	result := domain.Dashboard{Hosts: map[string]int{}, Instances: map[string]int{}}
	rows, err := s.pool.Query(ctx, "SELECT status, count(*) FROM hosts GROUP BY status")
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return result, err
		}
		result.Hosts[status] = count
	}
	rows.Close()
	rows, err = s.pool.Query(ctx, "SELECT status, count(*) FROM instances WHERE status <> 'deleted' GROUP BY status")
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return result, err
		}
		result.Instances[status] = count
	}
	rows.Close()
	err = s.pool.QueryRow(ctx, `SELECT
        (SELECT count(*) FROM tasks WHERE status IN ('queued','running')),
        (SELECT count(*) FROM alerts WHERE status <> 'resolved'),
        (SELECT count(*) FROM users WHERE disabled_at IS NULL),
        (SELECT count(*) FROM projects)`).Scan(&result.ActiveTasks, &result.OpenAlerts, &result.Users, &result.Projects)
	return result, err
}

type AuditInput struct {
	UserID       *uuid.UUID
	Username     string
	Action       string
	ResourceType string
	ResourceID   *uuid.UUID
	ResourceName string
	IP           string
	RequestID    string
	TaskID       *uuid.UUID
	Result       string
	Changes      any
	Message      string
}

func (s *Store) AddAudit(ctx context.Context, input AuditInput) error {
	changes, err := marshalAuditChanges(input.Changes)
	if err != nil || string(changes) == "null" {
		changes = []byte("{}")
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO audit_logs
        (user_id,username,action,resource_type,resource_id,resource_name,ip,request_id,task_id,result,changes,message)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, input.UserID, input.Username,
		input.Action, input.ResourceType, input.ResourceID, input.ResourceName, input.IP, input.RequestID,
		input.TaskID, input.Result, changes, input.Message)
	return err
}

func marshalAuditChanges(input any) ([]byte, error) {
	raw, err := json.Marshal(input)
	if err != nil || string(raw) == "null" {
		return raw, err
	}
	var value any
	if err = json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	redactAuditValue(value)
	return json.Marshal(value)
}

func redactAuditValue(value any) {
	switch current := value.(type) {
	case map[string]any:
		for key, child := range current {
			if auditSensitiveKey(key) {
				if _, safeFlag := child.(bool); !safeFlag {
					current[key] = "[REDACTED]"
					continue
				}
			}
			redactAuditValue(child)
		}
	case []any:
		for _, child := range current {
			redactAuditValue(child)
		}
	}
}

func auditSensitiveKey(key string) bool {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "", " ", "", ".", "").Replace(key))
	for _, fragment := range []string{"password", "secret", "token", "credential", "privatekey", "passphrase", "authorization", "cookie", "connectionuri", "jdbcuri"} {
		if strings.Contains(normalized, fragment) {
			return true
		}
	}
	return false
}

type AuditFilter struct {
	Search              string
	ResourceType        string
	Result              string
	ActionAliases       []string
	ResourceTypeAliases []string
	Before              time.Time
	Limit               int
	Offset              int
}

func (s *Store) ListAudit(ctx context.Context, filter AuditFilter) ([]domain.AuditLog, error) {
	if filter.Limit <= 0 || filter.Limit > 500 {
		filter.Limit = 100
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}
	if filter.Before.IsZero() {
		filter.Before = time.Now().Add(time.Hour)
	}
	rows, err := s.pool.Query(ctx, `SELECT id,user_id,username,action,resource_type,resource_id,resource_name,
        ip,request_id,task_id,result,changes,message,created_at FROM audit_logs
        WHERE created_at < $1
        AND ($2='' OR resource_type=$2)
        AND ($3='' OR result=$3)
        AND ($4='' OR username ILIKE '%'||$4||'%' OR action ILIKE '%'||$4||'%'
          OR resource_type ILIKE '%'||$4||'%' OR COALESCE(resource_id::text,'') ILIKE '%'||$4||'%'
          OR resource_name ILIKE '%'||$4||'%' OR result ILIKE '%'||$4||'%'
          OR ip ILIKE '%'||$4||'%' OR request_id ILIKE '%'||$4||'%'
          OR COALESCE(task_id::text,'') ILIKE '%'||$4||'%' OR message ILIKE '%'||$4||'%'
          OR changes::text ILIKE '%'||$4||'%' OR action = ANY($5::text[])
          OR resource_type = ANY($6::text[]))
        ORDER BY created_at DESC LIMIT $7 OFFSET $8`, filter.Before, filter.ResourceType, filter.Result, filter.Search,
		filter.ActionAliases, filter.ResourceTypeAliases, filter.Limit, filter.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.AuditLog, 0)
	for rows.Next() {
		var item domain.AuditLog
		if err := rows.Scan(&item.ID, &item.UserID, &item.Username, &item.Action, &item.ResourceType,
			&item.ResourceID, &item.ResourceName, &item.IP, &item.RequestID, &item.TaskID, &item.Result,
			&item.Changes, &item.Message, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) CountAudit(ctx context.Context, filter AuditFilter) (int64, error) {
	if filter.Before.IsZero() {
		filter.Before = time.Now().Add(time.Hour)
	}
	var total int64
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs
        WHERE created_at < $1
        AND ($2='' OR resource_type=$2)
        AND ($3='' OR result=$3)
        AND ($4='' OR username ILIKE '%'||$4||'%' OR action ILIKE '%'||$4||'%'
          OR resource_type ILIKE '%'||$4||'%' OR COALESCE(resource_id::text,'') ILIKE '%'||$4||'%'
          OR resource_name ILIKE '%'||$4||'%' OR result ILIKE '%'||$4||'%'
          OR ip ILIKE '%'||$4||'%' OR request_id ILIKE '%'||$4||'%'
          OR COALESCE(task_id::text,'') ILIKE '%'||$4||'%' OR message ILIKE '%'||$4||'%'
          OR changes::text ILIKE '%'||$4||'%' OR action = ANY($5::text[])
          OR resource_type = ANY($6::text[]))`, filter.Before, filter.ResourceType, filter.Result, filter.Search,
		filter.ActionAliases, filter.ResourceTypeAliases).Scan(&total)
	return total, err
}

func (s *Store) ClearAudit(ctx context.Context, before time.Time) (int64, error) {
	result, err := s.pool.Exec(ctx, "DELETE FROM audit_logs WHERE created_at < $1", before)
	return result.RowsAffected(), err
}

func (s *Store) GetSettings(ctx context.Context) (map[string]json.RawMessage, error) {
	rows, err := s.pool.Query(ctx, "SELECT key,value FROM settings ORDER BY key")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]json.RawMessage)
	for rows.Next() {
		var key string
		var value json.RawMessage
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		result[key] = value
	}
	return result, rows.Err()
}

func (s *Store) PutSetting(ctx context.Context, key string, value json.RawMessage) error {
	if !json.Valid(value) {
		return fmt.Errorf("%w: setting value is not valid JSON", domain.ErrInvalid)
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`, key, value)
	return err
}
