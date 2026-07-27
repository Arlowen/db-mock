package store

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

type ProjectInput struct {
	Name               string
	Description        string
	Color              string
	DefaultEnvironment *string
	DefaultExpiryDays  *int
	DefaultLabels      json.RawMessage
}

func normalizeProjectInput(input ProjectInput) (ProjectInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" {
		return ProjectInput{}, domain.ErrInvalid
	}
	if input.Color == "" {
		input.Color = "#1677ff"
	}
	if input.DefaultEnvironment != nil {
		environment := strings.TrimSpace(*input.DefaultEnvironment)
		if environment == "" {
			input.DefaultEnvironment = nil
		} else if environment != "development" && environment != "testing" && environment != "staging" && environment != "production" {
			return ProjectInput{}, domain.ErrInvalid
		} else {
			input.DefaultEnvironment = &environment
		}
	}
	if input.DefaultExpiryDays != nil && (*input.DefaultExpiryDays < 0 || *input.DefaultExpiryDays > 365) {
		return ProjectInput{}, domain.ErrInvalid
	}
	if len(input.DefaultLabels) == 0 {
		input.DefaultLabels = json.RawMessage(`{}`)
	}
	var labels map[string]string
	if err := json.Unmarshal(input.DefaultLabels, &labels); err != nil {
		return ProjectInput{}, domain.ErrInvalid
	}
	if labels == nil {
		labels = map[string]string{}
	}
	input.DefaultLabels, _ = json.Marshal(labels)
	return input, nil
}

func (s *Store) CreateProject(ctx context.Context, input ProjectInput) (domain.Project, error) {
	input, err := normalizeProjectInput(input)
	if err != nil {
		return domain.Project{}, domain.ErrInvalid
	}
	item := domain.Project{ID: uuid.New(), Name: input.Name, Description: input.Description, Color: input.Color,
		DefaultEnvironment: input.DefaultEnvironment, DefaultExpiryDays: input.DefaultExpiryDays, DefaultLabels: input.DefaultLabels}
	err = s.pool.QueryRow(ctx, `INSERT INTO projects(id,name,description,color,default_environment,default_expiry_days,default_labels)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING created_at,updated_at`,
		item.ID, item.Name, item.Description, item.Color, item.DefaultEnvironment, item.DefaultExpiryDays, item.DefaultLabels).
		Scan(&item.CreatedAt, &item.UpdatedAt)
	if err != nil && strings.Contains(err.Error(), "projects_name_lower_idx") {
		return domain.Project{}, domain.ErrConflict
	}
	return item, err
}

func (s *Store) ListProjects(ctx context.Context) ([]domain.Project, error) {
	rows, err := s.pool.Query(ctx, `SELECT p.id,p.name,p.description,p.color,p.default_environment,p.default_expiry_days,p.default_labels,
        (SELECT count(*) FROM hosts h WHERE h.project_id=p.id),
        (SELECT count(*) FROM instances i WHERE i.project_id=p.id AND i.status<>'deleted'),
        p.created_at,p.updated_at
        FROM projects p ORDER BY lower(p.name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Project, 0)
	for rows.Next() {
		var item domain.Project
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.Color, &item.DefaultEnvironment,
			&item.DefaultExpiryDays, &item.DefaultLabels, &item.HostCount, &item.InstanceCount,
			&item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetProject(ctx context.Context, id uuid.UUID) (domain.Project, error) {
	var item domain.Project
	err := s.pool.QueryRow(ctx, `SELECT p.id,p.name,p.description,p.color,p.default_environment,p.default_expiry_days,p.default_labels,
        (SELECT count(*) FROM hosts h WHERE h.project_id=p.id),
        (SELECT count(*) FROM instances i WHERE i.project_id=p.id AND i.status<>'deleted'),
        p.created_at,p.updated_at FROM projects p WHERE p.id=$1`, id).Scan(
		&item.ID, &item.Name, &item.Description, &item.Color, &item.DefaultEnvironment, &item.DefaultExpiryDays,
		&item.DefaultLabels, &item.HostCount, &item.InstanceCount, &item.CreatedAt, &item.UpdatedAt)
	return item, translate(err)
}

func (s *Store) UpdateProject(ctx context.Context, id uuid.UUID, input ProjectInput) (domain.Project, error) {
	input, err := normalizeProjectInput(input)
	if err != nil {
		return domain.Project{}, err
	}
	var item domain.Project
	err = s.pool.QueryRow(ctx, `WITH updated AS (
        UPDATE projects SET name=$2,description=$3,color=$4,default_environment=$5,
          default_expiry_days=$6,default_labels=$7,updated_at=now()
        WHERE id=$1 RETURNING id,name,description,color,default_environment,default_expiry_days,
          default_labels,created_at,updated_at
      )
      SELECT u.id,u.name,u.description,u.color,u.default_environment,u.default_expiry_days,u.default_labels,
        (SELECT count(*) FROM hosts h WHERE h.project_id=u.id),
        (SELECT count(*) FROM instances i WHERE i.project_id=u.id AND i.status<>'deleted'),
        u.created_at,u.updated_at FROM updated u`, id, input.Name, input.Description, input.Color,
		input.DefaultEnvironment, input.DefaultExpiryDays, input.DefaultLabels).Scan(
		&item.ID, &item.Name, &item.Description, &item.Color, &item.DefaultEnvironment, &item.DefaultExpiryDays,
		&item.DefaultLabels, &item.HostCount, &item.InstanceCount, &item.CreatedAt, &item.UpdatedAt)
	return item, translate(err)
}

func (s *Store) DeleteProject(ctx context.Context, id uuid.UUID) error {
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM instances WHERE project_id=$1 AND status<>'deleted')+
        (SELECT count(*) FROM hosts WHERE project_id=$1)`, id).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return domain.ErrConflict
	}
	result, err := s.pool.Exec(ctx, "DELETE FROM projects WHERE id=$1", id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}
