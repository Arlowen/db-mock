package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

type ProjectInput struct {
	Name                     string
	Description              string
	Color                    string
	DefaultEnvironment       *string
	DefaultExpiryDays        *int
	DefaultLabels            json.RawMessage
	DefaultTemplateVersionID *uuid.UUID
	DefaultCPU               *float64
	DefaultMemoryBytes       *int64
	DefaultDiskBytes         *int64
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
	if input.DefaultTemplateVersionID == nil {
		if input.DefaultCPU != nil || input.DefaultMemoryBytes != nil || input.DefaultDiskBytes != nil {
			return ProjectInput{}, fmt.Errorf("%w: deployment resources require a default template version", domain.ErrInvalid)
		}
	} else if input.DefaultCPU == nil || input.DefaultMemoryBytes == nil || input.DefaultDiskBytes == nil {
		return ProjectInput{}, fmt.Errorf("%w: default template deployments require CPU, memory, and disk", domain.ErrInvalid)
	}
	if input.DefaultCPU != nil && *input.DefaultCPU <= 0 {
		return ProjectInput{}, fmt.Errorf("%w: default CPU must be greater than zero", domain.ErrInvalid)
	}
	if input.DefaultMemoryBytes != nil && *input.DefaultMemoryBytes <= 0 {
		return ProjectInput{}, fmt.Errorf("%w: default memory must be greater than zero", domain.ErrInvalid)
	}
	if input.DefaultDiskBytes != nil && *input.DefaultDiskBytes <= 0 {
		return ProjectInput{}, fmt.Errorf("%w: default disk must be greater than zero", domain.ErrInvalid)
	}
	return input, nil
}

func validateProjectDeploymentProfile(ctx context.Context, tx pgx.Tx, input ProjectInput) error {
	if input.DefaultTemplateVersionID == nil {
		return nil
	}
	var minCPU float64
	var minMemoryBytes, minDiskBytes int64
	var selectable bool
	err := tx.QueryRow(ctx, `SELECT min_cpu,min_memory_bytes,min_disk_bytes,selectable
		FROM template_versions WHERE id=$1 FOR SHARE`, *input.DefaultTemplateVersionID).
		Scan(&minCPU, &minMemoryBytes, &minDiskBytes, &selectable)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: default template version does not exist", domain.ErrInvalid)
	}
	if err != nil {
		return err
	}
	if !selectable {
		return fmt.Errorf("%w: default template version is not available for new deployments", domain.ErrInvalid)
	}
	if *input.DefaultCPU < minCPU || *input.DefaultMemoryBytes < minMemoryBytes || *input.DefaultDiskBytes < minDiskBytes {
		return fmt.Errorf("%w: default resources cannot be below the template minimum", domain.ErrInvalid)
	}
	return nil
}

func saveProjectDeploymentProfile(ctx context.Context, tx pgx.Tx, projectID uuid.UUID, input ProjectInput) error {
	if input.DefaultTemplateVersionID == nil {
		_, err := tx.Exec(ctx, `DELETE FROM project_deployment_profiles WHERE project_id=$1`, projectID)
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO project_deployment_profiles(
			project_id,template_version_id,cpu,memory_bytes,disk_bytes)
		VALUES($1,$2,$3,$4,$5)
		ON CONFLICT(project_id) DO UPDATE SET template_version_id=excluded.template_version_id,
			cpu=excluded.cpu,memory_bytes=excluded.memory_bytes,disk_bytes=excluded.disk_bytes,updated_at=now()`,
		projectID, input.DefaultTemplateVersionID, input.DefaultCPU, input.DefaultMemoryBytes, input.DefaultDiskBytes)
	return err
}

const projectSelect = `SELECT p.id,p.name,p.description,p.color,p.default_environment,p.default_expiry_days,p.default_labels,
	profile.template_version_id,profile.cpu,profile.memory_bytes,profile.disk_bytes,
	template.name,version.version,version.selectable,
	(SELECT count(*) FROM hosts h WHERE h.project_id=p.id),
	(SELECT count(*) FROM instances i WHERE i.project_id=p.id AND i.status<>'deleted'),
	p.created_at,p.updated_at
	FROM projects p
	LEFT JOIN project_deployment_profiles profile ON profile.project_id=p.id
	LEFT JOIN template_versions version ON version.id=profile.template_version_id
	LEFT JOIN templates template ON template.id=version.template_id`

func projectScanArgs(item *domain.Project) []any {
	return []any{
		&item.ID, &item.Name, &item.Description, &item.Color, &item.DefaultEnvironment,
		&item.DefaultExpiryDays, &item.DefaultLabels, &item.DefaultTemplateVersionID,
		&item.DefaultCPU, &item.DefaultMemoryBytes, &item.DefaultDiskBytes,
		&item.DefaultTemplateName, &item.DefaultTemplateVersion, &item.DefaultTemplateSelectable,
		&item.HostCount, &item.InstanceCount, &item.CreatedAt, &item.UpdatedAt,
	}
}

func (s *Store) CreateProject(ctx context.Context, input ProjectInput) (domain.Project, error) {
	input, err := normalizeProjectInput(input)
	if err != nil {
		return domain.Project{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Project{}, err
	}
	defer tx.Rollback(ctx)
	if err = validateProjectDeploymentProfile(ctx, tx, input); err != nil {
		return domain.Project{}, err
	}
	item := domain.Project{ID: uuid.New()}
	_, err = tx.Exec(ctx, `INSERT INTO projects(id,name,description,color,default_environment,default_expiry_days,default_labels)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, item.ID, input.Name, input.Description, input.Color,
		input.DefaultEnvironment, input.DefaultExpiryDays, input.DefaultLabels)
	if err != nil && strings.Contains(err.Error(), "projects_name_lower_idx") {
		return domain.Project{}, domain.ErrConflict
	}
	if err != nil {
		return domain.Project{}, err
	}
	if err = saveProjectDeploymentProfile(ctx, tx, item.ID, input); err != nil {
		return domain.Project{}, err
	}
	err = tx.QueryRow(ctx, projectSelect+` WHERE p.id=$1`, item.ID).Scan(projectScanArgs(&item)...)
	if err != nil {
		return domain.Project{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Project{}, err
	}
	return item, nil
}

func (s *Store) ListProjects(ctx context.Context) ([]domain.Project, error) {
	rows, err := s.pool.Query(ctx, projectSelect+` ORDER BY lower(p.name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Project, 0)
	for rows.Next() {
		var item domain.Project
		if err := rows.Scan(projectScanArgs(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetProject(ctx context.Context, id uuid.UUID) (domain.Project, error) {
	var item domain.Project
	err := s.pool.QueryRow(ctx, projectSelect+` WHERE p.id=$1`, id).Scan(projectScanArgs(&item)...)
	return item, translate(err)
}

func (s *Store) UpdateProject(ctx context.Context, id uuid.UUID, input ProjectInput) (domain.Project, error) {
	input, err := normalizeProjectInput(input)
	if err != nil {
		return domain.Project{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Project{}, err
	}
	defer tx.Rollback(ctx)
	if err = validateProjectDeploymentProfile(ctx, tx, input); err != nil {
		return domain.Project{}, err
	}
	result, err := tx.Exec(ctx, `UPDATE projects SET name=$2,description=$3,color=$4,default_environment=$5,
		default_expiry_days=$6,default_labels=$7,updated_at=now() WHERE id=$1`,
		id, input.Name, input.Description, input.Color, input.DefaultEnvironment, input.DefaultExpiryDays, input.DefaultLabels)
	if err != nil && strings.Contains(err.Error(), "projects_name_lower_idx") {
		return domain.Project{}, domain.ErrConflict
	}
	if err != nil {
		return domain.Project{}, err
	}
	if result.RowsAffected() == 0 {
		return domain.Project{}, domain.ErrNotFound
	}
	if err = saveProjectDeploymentProfile(ctx, tx, id, input); err != nil {
		return domain.Project{}, err
	}
	var item domain.Project
	if err = tx.QueryRow(ctx, projectSelect+` WHERE p.id=$1`, id).Scan(projectScanArgs(&item)...); err != nil {
		return domain.Project{}, translate(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Project{}, err
	}
	return item, nil
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
