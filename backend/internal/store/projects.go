package store

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func (s *Store) CreateProject(ctx context.Context, name, description, color string) (domain.Project, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return domain.Project{}, domain.ErrInvalid
	}
	if color == "" {
		color = "#1677ff"
	}
	item := domain.Project{ID: uuid.New(), Name: name, Description: description, Color: color}
	err := s.pool.QueryRow(ctx, `INSERT INTO projects(id,name,description,color) VALUES($1,$2,$3,$4)
        RETURNING created_at,updated_at`, item.ID, item.Name, item.Description, item.Color).Scan(&item.CreatedAt, &item.UpdatedAt)
	if err != nil && strings.Contains(err.Error(), "projects_name_lower_idx") {
		return domain.Project{}, domain.ErrConflict
	}
	return item, err
}

func (s *Store) ListProjects(ctx context.Context) ([]domain.Project, error) {
	rows, err := s.pool.Query(ctx, `SELECT p.id,p.name,p.description,p.color,
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
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.Color, &item.HostCount, &item.InstanceCount, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetProject(ctx context.Context, id uuid.UUID) (domain.Project, error) {
	var item domain.Project
	err := s.pool.QueryRow(ctx, `SELECT p.id,p.name,p.description,p.color,
        (SELECT count(*) FROM hosts h WHERE h.project_id=p.id),
        (SELECT count(*) FROM instances i WHERE i.project_id=p.id AND i.status<>'deleted'),
        p.created_at,p.updated_at FROM projects p WHERE p.id=$1`, id).Scan(
		&item.ID, &item.Name, &item.Description, &item.Color, &item.HostCount, &item.InstanceCount, &item.CreatedAt, &item.UpdatedAt)
	return item, translate(err)
}

func (s *Store) UpdateProject(ctx context.Context, id uuid.UUID, name, description, color string) (domain.Project, error) {
	var item domain.Project
	err := s.pool.QueryRow(ctx, `WITH updated AS (
        UPDATE projects SET name=$2,description=$3,color=$4,updated_at=now()
        WHERE id=$1 RETURNING id,name,description,color,created_at,updated_at
      )
      SELECT u.id,u.name,u.description,u.color,
        (SELECT count(*) FROM hosts h WHERE h.project_id=u.id),
        (SELECT count(*) FROM instances i WHERE i.project_id=u.id AND i.status<>'deleted'),
        u.created_at,u.updated_at FROM updated u`, id, strings.TrimSpace(name), description, color).Scan(
		&item.ID, &item.Name, &item.Description, &item.Color, &item.HostCount, &item.InstanceCount, &item.CreatedAt, &item.UpdatedAt)
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
